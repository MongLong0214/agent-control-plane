import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import { describe, it, expect, afterEach } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { parseRepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import {
  produceRepoFactoryResult,
  repositoryCheckoutPath,
  type RepoFactoryPlanFixture,
} from "../../src/bootstrap/repo-factory-producer.ts";

/**
 * Issue #246 — the control plane's half of the bootstrap contract (repo-factory-result.ts)
 * has existed with nothing producing it; every test handed the parser a hand-written
 * fixture. These tests build a real local filesystem/git producer and prove its output
 * — never a hand-authored RepoFactoryResult — satisfies the real parser.
 */

const sandboxes: string[] = [];

const makeSandbox = (): { sandbox: string; workDir: string } => {
  const sandbox = mkdtempSync(join(tmpdir(), "acp-246-producer-"));
  sandboxes.push(sandbox);
  const workDir = join(sandbox, "workdir");
  return { sandbox, workDir };
};

afterEach(async () => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const basePlan = (): RepoFactoryPlanFixture => ({
  runId: "run_bootstrap_246",
  bootstrapOperationId: "bootstrap_246",
  requestDigest: "sha256:" + "a".repeat(64),
  planDigest: "sha256:" + "b".repeat(64),
  projectManifestDigest: "sha256:" + "c".repeat(64),
  repositoryRole: "primary",
  defaultBranch: "main",
  verificationCommandId: "local-clean-tree",
  verificationArgs: ["status", "--porcelain"],
  githubOperations: [],
});

describe("repo factory producer (#246)", () => {
  it("produces a RepoFactoryResult — never hand-written — that the real parser accepts", async () => {
    const { workDir } = makeSandbox();
    const produced = await produceRepoFactoryResult({
      plan: basePlan(),
      workDir,
      clock: new ManualClock("2026-08-23T00:00:00.000Z"),
    });

    expect(produced.allowed).toBe(true);
    if (!produced.allowed) return;

    const parsed = parseRepoFactoryResult(produced.value);
    expect(parsed.allowed).toBe(true);

    expect(produced.value.repositories).toHaveLength(1);
    expect(produced.value.externalWriteReceipts).toHaveLength(1);
    expect(produced.value.bootstrapVerification).toHaveLength(1);
    expect(produced.value.bootstrapVerification[0]?.exactHead).toMatch(/^[0-9a-f]{40}$/);
    expect(produced.value.ciEvidence).toEqual([]);
    expect(produced.value.unresolvedGaps).toEqual([]);
  });

  it("is rejected by the real overclaim check when a forbidden activation claim is added to genuine producer output", async () => {
    const { workDir } = makeSandbox();
    const produced = await produceRepoFactoryResult({
      plan: basePlan(),
      workDir,
      clock: new ManualClock("2026-08-23T00:00:00.000Z"),
    });
    expect(produced.allowed).toBe(true);
    if (!produced.allowed) return;

    const overclaiming = { ...produced.value, activity: "ACTIVE" };
    const parsed = parseRepoFactoryResult(overclaiming);
    expect(parsed.allowed).toBe(false);
    if (parsed.allowed) return;
    expect(parsed.reasonCode).toBe(ReasonCode.BOOTSTRAP_RESULT_OVERCLAIMS_ACTIVATION);
  });

  it("refuses a plan that requires a GitHub write instead of fabricating a receipt for one", async () => {
    const { workDir } = makeSandbox();
    const plan: RepoFactoryPlanFixture = {
      ...basePlan(),
      githubOperations: [
        { operationId: "repo-create", resourceType: "repository", resourceIdentity: "github:acme/repo" },
      ],
    };
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
    // Refusing before ever touching the filesystem — no local checkout was fabricated either.
    expect(existsSync(repositoryCheckoutPath(workDir, plan.repositoryRole))).toBe(false);
  });

  it("refuses to record a fabricated PASS when the local verification command genuinely fails", async () => {
    const { workDir } = makeSandbox();
    const plan: RepoFactoryPlanFixture = {
      ...basePlan(),
      // A real, deterministically-failing git command: no such branch exists in the
      // repository this producer just created.
      verificationArgs: ["rev-parse", "--verify", "refs/heads/does-not-exist"],
    };
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
  });

  it("refuses to overwrite or silently resume a preexisting same-named local checkout", async () => {
    const { workDir } = makeSandbox();
    const plan = basePlan();
    const checkoutPath = repositoryCheckoutPath(workDir, plan.repositoryRole);
    mkdirSync(dirname(checkoutPath), { recursive: true });
    writeFileSync(checkoutPath, "collision", { flag: "wx" });
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
  });

  it("rejects a repository role that would escape the given work directory", async () => {
    const { workDir } = makeSandbox();
    const plan: RepoFactoryPlanFixture = { ...basePlan(), repositoryRole: "../../etc" };
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
  });

  it("writes only inside the given work directory and nothing outside it", async () => {
    const { sandbox, workDir } = makeSandbox();
    const outsideMarker = join(sandbox, "outside.txt");
    writeFileSync(outsideMarker, "sentinel");

    const produced = await produceRepoFactoryResult({ plan: basePlan(), workDir });
    expect(produced.allowed).toBe(true);

    expect(readFileSync(outsideMarker, "utf8")).toBe("sentinel");
    expect(readdirSync(sandbox).sort()).toEqual(["outside.txt", "workdir"].sort());
    if (!produced.allowed) return;
    const proposedPath = produced.value.repositories[0]?.proposedCheckoutPath;
    expect(proposedPath).toBeTruthy();
    expect(proposedPath?.startsWith(workDir)).toBe(true);
  });
});
