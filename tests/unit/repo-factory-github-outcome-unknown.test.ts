import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createBootstrapGitHubWritePort, runUnderWriteGuard } from "../../src/bootstrap/bootstrap-write-guard.ts";
import type { GitHubVisibility, GitHubWritePort } from "../../src/bootstrap/github-write-port.ts";
import { applyGitHubOperations, type GitHubOperationReceipt, type PendingWrite } from "../../src/bootstrap/repo-factory-github.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { ownerApprovalFor, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Larger than any pipe buffer, so a `gh` that shuts its stdin cannot have taken the body. */
const LARGE = 1 << 20;

/**
 * FIX-1147-R1 — a `gh` stand-in, on a PATH that leaves the real `gh` out, so nothing here reaches
 * GitHub. Every request is logged as `METHOD path`. Reads answer for an organization owner whose
 * repository is `FAKE_GH_REPO` (absent when unset) with no branch protection; a write does what
 * `FAKE_GH_MODE` says: `drops` shuts its stdin unread and fails with no HTTP status, the port's
 * request-outcome-unknown case; `refuses-422` reads the whole body and is refused by GitHub.
 */
const FAKE_GH = String.raw`#!/bin/sh
echo "$5 $6" >> "$FAKE_GH_LOG"
if [ "$5" = GET ]; then
  case "$6" in
    users/*) printf '{"type":"Organization"}'; exit 0 ;;
    */protection) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  esac
  if [ -n "$FAKE_GH_REPO" ]; then printf '%s' "$FAKE_GH_REPO"; exit 0; fi
  echo 'gh: Not Found (HTTP 404)' >&2; exit 1
fi
case "$FAKE_GH_MODE" in
  drops) exec 0<&-; /bin/sleep 0.1; echo 'gh: input failed' >&2; exit 4 ;;
  refuses-422) cat >/dev/null; echo 'gh: Validation Failed (HTTP 422)' >&2; exit 1 ;;
esac
echo "fake gh: unknown mode $FAKE_GH_MODE" >&2
exit 99
`;

const installFakeGh = (mode: "drops" | "refuses-422", repo: string | null): string => {
  const root = tempDir("fix-1147-r1-gh-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const log = join(root, "requests.log");
  writeFileSync(log, "");
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("FAKE_GH_LOG", log);
  vi.stubEnv("FAKE_GH_MODE", mode);
  vi.stubEnv("FAKE_GH_REPO", repo ?? "");
  return log;
};

const writesIn = (log: string): string[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => /^(POST|PATCH|PUT|DELETE) /.test(line));

describe("FIX-1147-R1: a request whose outcome is unknown stays unknown, structured, up to the runner", () => {
  /**
   * The runner, its producer and the production port over `gh`, with only the create's body made larger
   * than a pipe so a `gh` that does not read it cannot have taken it (the marker the producer sends is
   * otherwise short enough to sit whole in the pipe).
   */
  const runCreate = async (mode: "drops" | "refuses-422", calls: number) => {
    const log = installFakeGh(mode, null);
    const ops = [
      {
        operationId: "create-repository:fixture",
        resourceType: "repository",
        resourceIdentity: "github:acme/fixture",
        desiredState: { visibility: "public", autoInit: true },
      },
    ];
    const base = cleanTreeManifest("fix-1147-r1-runner");
    const prepared = await prepareBootstrapRun("fix-1147-r1-runner", {
      ops,
      manifest: { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } },
    });
    try {
      const port = createBootstrapGitHubWritePort();
      vi.spyOn(prepared.github, "observeRepository").mockImplementation((target) => port.observeRepository(target));
      vi.spyOn(prepared.github, "createRepository").mockImplementation((target, visibility, description, autoInit) =>
        port.createRepository(target, visibility as GitHubVisibility, `${description ?? ""}${"x".repeat(LARGE)}`, autoInit),
      );
      const input = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
      const results = [];
      const durable = [];
      for (let call = 0; call < calls; call += 1) {
        results.push(await prepared.runner.produceAndActivate(input));
        durable.push(prepared.harness.cp.bootstrapApplications.get(prepared.runId)?.lastRefusal ?? null);
      }
      const ledger = JSON.parse(
        readFileSync(join(prepared.workRoot, prepared.runId, "github-ledger", "primary.json"), "utf8"),
      ) as { receipts: unknown[]; pending: PendingWrite[] };
      return { results, durable, ledger, writes: writesIn(log) };
    } finally {
      prepared.harness.cp.close();
    }
  };

  it("keeps a create gh did not take classified unknown in the runner's answer and its durable refusal, pending, and sent exactly once over three calls", async () => {
    const { results, durable, ledger, writes } = await runCreate("drops", 3);
    const [first, second, third] = results;

    expect(first).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      evidence: {
        stage: "production",
        refusal: "REQUEST_OUTCOME_UNKNOWN",
        failedOperationId: "create-repository:fixture",
        pendingOperationIds: ["create-repository:fixture"],
        indeterminate: true,
        resumable: false,
        remote: { status: null, requestOutcome: "unknown" },
      },
    });
    // Never the ordinary refusal a retry may follow.
    expect(first!.allowed ? null : first!.evidence["refusal"]).not.toBe("REMOTE_REFUSED");
    // The durable refusal is the same structured classification, not a message to re-read.
    expect(durable[0]).toMatchObject({
      stage: "production",
      evidence: { refusal: "REQUEST_OUTCOME_UNKNOWN", resumable: false, remote: { status: null, requestOutcome: "unknown" } },
    });

    // Later calls reconcile the pending intent first: GitHub shows nothing, so it stays in doubt, unsent.
    for (const later of [second, third]) {
      expect(later).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
        evidence: { refusal: "UNCONFIRMED_PENDING_REQUEST", operationId: "create-repository:fixture" },
      });
    }
    expect(ledger.receipts).toEqual([]);
    expect(ledger.pending).toHaveLength(1);
    expect(ledger.pending[0]).toMatchObject({ operationId: "create-repository:fixture", respondedNodeId: null });
    // Exactly one fake write in total: the first call's POST, and none after.
    expect(writes).toEqual(["POST orgs/acme/repos"]);
  });

  it("control: a create GitHub refused after taking the whole body is still the ordinary refusal, with its status", async () => {
    const { results, durable, writes } = await runCreate("refuses-422", 1);
    expect(results[0]).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      evidence: { refusal: "REMOTE_REFUSED", resumable: true, remote: { status: 422 } },
    });
    const remote = results[0]!.allowed ? null : (results[0]!.evidence["remote"] as Record<string, unknown>);
    expect(Object.keys(remote ?? {}).sort()).toEqual(["message", "status"]);
    expect(durable[0]).toMatchObject({ evidence: { refusal: "REMOTE_REFUSED", resumable: true, remote: { status: 422 } } });
    expect(writes).toEqual(["POST orgs/acme/repos"]);
  });
});

describe("FIX-1147-R1: setting and protection writes share the mapping", () => {
  const owner = "acme";
  const name = "fixture";
  const identity = `github:${owner}/${name}`;
  const repo = JSON.stringify({ node_id: "R_fixture", full_name: `${owner}/${name}`, visibility: "public", default_branch: "main" });
  const createReceipt: GitHubOperationReceipt = {
    operationId: "create",
    resourceType: "repository",
    resourceIdentity: identity,
    repositoryNodeId: "R_fixture",
    preexisting: false,
    beforeStateDigest: null,
    observed: { nodeId: "R_fixture", fullName: `${owner}/${name}`, visibility: "public" },
    createdAt: "2026-01-01T00:00:00.000Z",
    rereadAt: "2026-01-01T00:00:00.000Z",
  };
  const create = { operationId: "create", resourceType: "repository" as const, resourceIdentity: identity, desiredState: { visibility: "public" as const } };
  const kinds = {
    setting: {
      method: "PATCH",
      path: `repos/${owner}/${name}`,
      operation: {
        operationId: "setting",
        resourceType: "setting" as const,
        resourceIdentity: `${identity}#default-branch`,
        desiredState: { defaultBranch: "b".repeat(LARGE) },
      },
    },
    protection: {
      method: "PUT",
      path: `repos/${owner}/${name}/branches/main/protection`,
      operation: {
        operationId: "protection",
        resourceType: "branch-protection" as const,
        resourceIdentity: `${identity}#main`,
        desiredState: {
          requiredStatusChecks: { strict: true, contexts: ["c".repeat(LARGE)] },
          enforceAdmins: true,
          requiredApprovingReviewCount: 1,
          allowForcePushes: false,
          allowDeletions: false,
        },
      },
    },
  } as const;

  const apply = async (port: GitHubWritePort, kind: keyof typeof kinds, pending: readonly PendingWrite[]) => {
    const root = tempDir("fix-1147-r1-apply-");
    let stored: { receipts: GitHubOperationReceipt[]; pending: PendingWrite[] } | null = null;
    const result = await runUnderWriteGuard({ beforeRequest() {} }, () =>
      applyGitHubOperations({
        execution: {
          target: { owner, name },
          repositoryIdentity: identity,
          visibility: "public",
          operations: [create, kinds[kind].operation] as never,
          createOnly: false,
          pushOperationId: null,
        },
        port,
        checkoutPath: root,
        defaultBranch: "main",
        prior: {
          receipts: new Map([["create", createReceipt]]),
          pending: new Map(pending.map((entry) => [entry.operationId, entry])),
        },
        record: (state) => {
          stored = { receipts: [...state.receipts], pending: [...state.pending] };
        },
        ledgerPath: join(root, "ledger.json"),
        clock: new ManualClock(),
        provenUnsent: () => false,
        consumeExemption: () => {},
        approvedTree: async () => {
          throw new Error("no tree is checked here");
        },
        validatedHead: "a".repeat(40),
      }),
    );
    return { result, stored: stored as { receipts: GitHubOperationReceipt[]; pending: PendingWrite[] } | null };
  };

  for (const kind of ["setting", "protection"] as const) {
    it(`keeps a ${kind} body gh did not take classified unknown, pending, and never sent again`, async () => {
      const log = installFakeGh("drops", repo);
      const port = createBootstrapGitHubWritePort();
      const first = await apply(port, kind, []);
      expect(first.result).toMatchObject({
        allowed: false,
        evidence: {
          refusal: "REQUEST_OUTCOME_UNKNOWN",
          failedOperationId: kinds[kind].operation.operationId,
          indeterminate: true,
          resumable: false,
          remote: { status: null, requestOutcome: "unknown" },
        },
      });
      expect(first.stored?.pending.map((entry) => entry.operationId)).toEqual([kinds[kind].operation.operationId]);

      const second = await apply(port, kind, first.stored?.pending ?? []);
      expect(second.result).toMatchObject({
        allowed: false,
        evidence: { refusal: "UNCONFIRMED_PENDING_REQUEST", failedOperationId: kinds[kind].operation.operationId },
      });
      expect(writesIn(log)).toEqual([`${kinds[kind].method} ${kinds[kind].path}`]);
    });

    it(`control: a ${kind} GitHub refused after taking the whole body is still the ordinary refusal`, async () => {
      const log = installFakeGh("refuses-422", repo);
      const { result } = await apply(createBootstrapGitHubWritePort(), kind, []);
      expect(result).toMatchObject({
        allowed: false,
        evidence: { refusal: "REMOTE_REFUSED", resumable: true, remote: { status: 422 } },
      });
      const remote = result.allowed ? null : (result.evidence["remote"] as Record<string, unknown>);
      expect(Object.keys(remote ?? {}).sort()).toEqual(["message", "status"]);
      expect(writesIn(log)).toEqual([`${kinds[kind].method} ${kinds[kind].path}`]);
    });
  }
});
