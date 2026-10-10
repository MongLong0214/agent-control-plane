import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { createBootstrapGitHubWritePort, runUnderWriteGuard } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { createGitHubApiWritePort } from "../../src/bootstrap/github-write-port.ts";
import { produceRepoFactoryResult, type RepoFactoryPlanFixture } from "../../src/bootstrap/repo-factory-producer.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { InitializingGitHub, type Operation } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Issue #246 C5, review round 1 — the reviewer's regressions for C5I-R1-02 and C5I-R1-03, adopted with
 * their setup and assertions unchanged (the review's evidence dumps are left out). Both drive the
 * producer directly, with no runner in front of it.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const ops: Operation[] = [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository",
    resourceIdentity: "github:acme/fixture",
    desiredState: { visibility: "public", autoInit: true },
  },
];
const plan = {
  runId: "run_review_c5",
  bootstrapOperationId: "bootstrap_review_c5",
  requestDigest: "request",
  planDigest: "plan",
  projectManifestDigest: "manifest",
  repositoryRole: "primary",
  defaultBranch: "main",
  verificationCommandId: "clean-tree",
  verificationKind: "CLEAN_TREE",
  githubOperations: ops,
} as unknown as RepoFactoryPlanFixture;
const authority = {
  owner: "acme",
  visibility: "public" as const,
  approvedOperations: ops.map(({ operationId, resourceType, resourceIdentity }) => ({ operationId, resourceType, resourceIdentity })),
};
const produce = (workDir: string, port: InitializingGitHub) =>
  produceRepoFactoryResult({ plan, workDir, clock: new ManualClock(), github: { port, authority } });

it("review C5I-R1-02: a create-only producer must keep an unanswered create in doubt without retrying", async () => {
  const root = tempDir("acp-c5-review-pending-");
  const github = new InitializingGitHub(root);
  const workDir = join(root, "work");
  github.failNext = "createRepository";
  await produce(workDir, github);
  const second = await produce(workDir, github);
  expect(github.createRequests, "the same unresolved create request was sent again").toHaveLength(1);
  expect(second.allowed).toBe(false);
});

it("review C5I-R1-03: an empty provider node id is an unclear create response, never a verified create-only result", async () => {
  const root = tempDir("acp-c5-review-empty-id-");
  const github = new InitializingGitHub(root);
  const workDir = join(root, "work");
  const client: GitHubClient = {
    async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
      if (path === "users/acme") return { type: "Organization" } as T;
      if (method === "POST") {
        await github.createRepository({ owner: "acme", name: "fixture" }, "public", "marker", (body as { auto_init: boolean }).auto_init);
        github.repository("acme", "fixture")!.nodeId = "";
      }
      const repo = github.repository("acme", "fixture");
      if (!repo) throw acpError(ReasonCode.NOT_FOUND, "Not Found", { status: 404 });
      if (path.endsWith("/branches/main")) {
        const branch = await github.observeBranch({ owner: "acme", name: "fixture" }, "main");
        return { name: branch!.name, commit: { sha: branch!.headSha } } as T;
      }
      return { node_id: "", full_name: "acme/fixture", visibility: "public", default_branch: "main" } as T;
    },
  };
  const port = createBootstrapGitHubWritePort(client, async (cwd, args) => {
    if (!args.includes("fetch")) throw new Error("unexpected git command: " + args.join(" "));
    await github.fetchBranch({ owner: "acme", name: "fixture" }, "main", cwd);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const actual = await runUnderWriteGuard({ beforeRequest() {} }, () =>
    produceRepoFactoryResult({ plan, workDir, clock: new ManualClock(), github: { port, authority } }),
  );
  expect(actual.allowed, "an empty provider identity was receipted as verified").toBe(false);
});

it("C5I-R1-03: a create answer with no valid node id from any port is not recorded or accepted, and the create is never sent again", async () => {
  const root = tempDir("acp-c5-r1-unidentified-");
  const github = new InitializingGitHub(root);
  const workDir = join(root, "work");
  const create = github.createRepository.bind(github);
  vi.spyOn(github, "createRepository").mockImplementationOnce(async (...args: Parameters<typeof create>) => ({
    ...(await create(...args)),
    nodeId: "",
  }));
  const first = await produce(workDir, github);
  expect(first, JSON.stringify(first)).toMatchObject({
    allowed: false,
    evidence: { refusal: "UNIDENTIFIED_CREATE_ANSWER", indeterminate: true, failedOperationId: "create-repository:fixture" },
  });
  const ledger = JSON.parse(readFileSync(join(workDir, "github-ledger", "primary.json"), "utf8")) as {
    receipts: unknown[];
    pending: Array<{ respondedNodeId: string | null }>;
  };
  expect(ledger.receipts).toEqual([]);
  expect(ledger.pending.map((intent) => intent.respondedNodeId)).toEqual([null]);
  // The create landed; with no identity recorded for it, the repository at the name is not adopted.
  const second = await produce(workDir, github);
  expect(second, JSON.stringify(second)).toMatchObject({
    allowed: false,
    reasonCode: ReasonCode.RESOURCE_COLLISION,
    evidence: { refusal: "WRONG_TARGET", indeterminate: true },
  });
  expect(github.createRequests).toHaveLength(1);
});

it("C5I-R1-03: the production port refuses an answer whose node id, full name or branch head is not a valid identity", async () => {
  const answers: Record<string, unknown> = {};
  const client: GitHubClient = {
    async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string): Promise<T> {
      const key = `${method} ${path}`;
      if (!(key in answers)) throw acpError(ReasonCode.NOT_FOUND, "Not Found", { status: 404 });
      return answers[key] as T;
    },
  };
  const port = createGitHubApiWritePort({ client });
  const target = { owner: "acme", name: "fixture" };
  const valid = { node_id: "R_kgDOvalid", full_name: "acme/fixture", visibility: "public", default_branch: "main" };
  for (const [field, value] of [["node_id", ""], ["node_id", "R kgDO"], ["full_name", ""], ["full_name", "fixture"]] as const) {
    answers["GET repos/acme/fixture"] = { ...valid, [field]: value };
    await expect(port.observeRepository(target), `${field}=${JSON.stringify(value)}`).rejects.toMatchObject({ reasonCode: ReasonCode.INTERNAL_ERROR });
  }
  answers["GET repos/acme/fixture"] = valid;
  expect(await port.observeRepository(target)).toMatchObject({ nodeId: "R_kgDOvalid", fullName: "acme/fixture" });
  for (const sha of ["", "a".repeat(39), "A".repeat(40)]) {
    answers["GET repos/acme/fixture/branches/main"] = { name: "main", commit: { sha } };
    await expect(port.observeBranch(target, "main"), `sha=${JSON.stringify(sha)}`).rejects.toMatchObject({ reasonCode: ReasonCode.INTERNAL_ERROR });
  }
  answers["GET repos/acme/fixture/branches/main"] = { name: "main", commit: { sha: "a".repeat(40) } };
  expect(await port.observeBranch(target, "main")).toEqual({ name: "main", headSha: "a".repeat(40) });
});
