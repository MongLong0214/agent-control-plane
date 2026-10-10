import { join } from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { produceRepoFactoryResult, type RepoFactoryPlanFixture } from "../../src/bootstrap/repo-factory-producer.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { InitializingGitHub, type Operation } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Issue #246 C5, review round 1 — the reviewer's regression for C5I-R1-02, adopted with
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
