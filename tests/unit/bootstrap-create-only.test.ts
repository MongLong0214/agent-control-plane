import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { plannedBootstrapOutputs } from "../../src/bootstrap/bootstrap-plan.ts";
import { type BootstrapWriteRequest, createBootstrapGitHubWritePort, runUnderWriteGuard } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { attemptCheckoutPath } from "../../src/bootstrap/repo-factory-bootstrap-run.ts";
import { BOOTSTRAP_CONTENT_FILE, produceRepoFactoryResult, type RepoFactoryPlanFixture } from "../../src/bootstrap/repo-factory-producer.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { git } from "../../src/git/git.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import {
  InitializingGitHub,
  type Operation,
  type PreparedBootstrapRun,
  activateAndConfirm,
  noGitHubCall,
  ownerApprovalFor,
  prepareBootstrapRun,
  writesOf,
} from "../helpers/bootstrap-runner.ts";
import type { FakeGitHub, Protection } from "../helpers/fake-github-write-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Issue #246, packet C5-init (CEO ruling B1 = (N)) — a create-only bootstrap: the PLAN's create asks
 * GitHub to initialize the repository, nothing is pushed, and the head the result reports is the
 * initialized default branch's, read back from GitHub. No marker exists in this mode: the bootstrap
 * content file is in no planned output, no tree and no result.
 *
 * GitHub is the bare-repository double with GitHub's `auto_init` added (`InitializingGitHub`). Every
 * refusal asserts the double's write log: a refusal that still wrote is the defect.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const IDENTITY = "github:acme/fixture";

/** The create-only PLAN: one create that states its initialization, and no push. */
const createOnlyOperations = (identity = IDENTITY, visibility: "public" | "private" = "public"): Operation[] => [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository",
    resourceIdentity: identity,
    desiredState: { visibility, autoInit: true },
  },
];

const PUSH: Operation = { operationId: "push-default-branch:fixture", resourceType: "branch", resourceIdentity: `${IDENTITY}#main` };

const PROTECTION: Protection = {
  requiredStatusChecks: { strict: true, contexts: ["project-ci"] },
  enforceAdmins: true,
  requiredApprovingReviewCount: 1,
  allowForcePushes: false,
  allowDeletions: false,
};

/** A clean-tree manifest whose default branch is `main` — the branch GitHub initializes here. */
const manifestFor = (projectId: string): ProjectManifest => {
  const base = cleanTreeManifest(projectId);
  return { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } };
};

const prepare = (projectId: string): Promise<PreparedBootstrapRun> =>
  prepareBootstrapRun(projectId, { ops: createOnlyOperations(), manifest: manifestFor(projectId) });

const ownerApproval = ownerApprovalFor;

const remoteHead = async (github: FakeGitHub, branch = "main"): Promise<string> => {
  const remote = github.repository("acme", "fixture");
  if (!remote) throw new Error("the double holds no repository");
  return (await git(remote.bare, ["rev-parse", `refs/heads/${branch}`])).stdout.trim();
};

// ── producer-level fixtures ──────────────────────────────────────────────────────────────────────

const sandbox = (): { workDir: string; github: InitializingGitHub } => {
  const root = tempDir("acp-c5-producer-");
  return { workDir: join(root, "workdir"), github: new InitializingGitHub(root) };
};

const fixturePlan = (ops: Operation[]) =>
  ({
    runId: "run_c5_create_only",
    bootstrapOperationId: "bootstrap_c5",
    requestDigest: "sha256:" + "a".repeat(64),
    planDigest: "sha256:" + "b".repeat(64),
    projectManifestDigest: "sha256:" + "c".repeat(64),
    repositoryRole: "primary",
    defaultBranch: "main",
    verificationCommandId: "clean-tree",
    verificationKind: "CLEAN_TREE",
    githubOperations: ops,
  }) as unknown as RepoFactoryPlanFixture;

const produce = (workDir: string, github: FakeGitHub, ops: Operation[], persist?: (result: RepoFactoryResult) => void) =>
  produceRepoFactoryResult({
    plan: fixturePlan(ops),
    workDir,
    clock: new ManualClock("2026-10-10T00:00:00.000Z"),
    github: {
      port: github,
      authority: {
        owner: "acme",
        visibility: "public",
        approvedOperations: ops.map(({ operationId, resourceType, resourceIdentity }) => ({ operationId, resourceType, resourceIdentity })),
      },
    },
    ...(persist === undefined ? {} : { persist }),
  } as Parameters<typeof produceRepoFactoryResult>[0]);

/**
 * GitHub changes between the create's own read-back and the read of its initialization. Producer-level
 * reads of the repository: 1 before the create, 2 the create's read-back, 3 the initialization's.
 */
const onInitializationRead = (github: InitializingGitHub, change: (github: InitializingGitHub) => unknown): void => {
  const observe = github.observeRepository.bind(github);
  let calls = 0;
  vi.spyOn(github, "observeRepository").mockImplementation(async (target) => {
    calls += 1;
    if (calls === 3) await change(github);
    return observe(target);
  });
};

const ledgerOf = (workDir: string): { receipts: Array<{ operationId: string; observed: Record<string, unknown> }>; pending: unknown[] } =>
  JSON.parse(readFileSync(join(workDir, "github-ledger", "primary.json"), "utf8"));

describe("#246 C5 create-only bootstrap: GitHub initializes the default branch and nothing is pushed", () => {
  it("W1: a create-only PLAN is planned with no file, created with auto_init, read back, and activated with no marker claimed", async () => {
    const prepared = await prepare("c5-create-only");
    const { harness, runId, github } = prepared;
    const outputs = plannedBootstrapOutputs({ runId, planArtifact: harness.cp.artifacts.latest(runId, "PLAN") }, prepared.manifest);
    expect(outputs, JSON.stringify(outputs)).toMatchObject({ allowed: true, value: { defaultBranch: "main", files: [] } });
    const push = vi.spyOn(github, "pushBranch");

    const { beforeConfirm, final } = await activateAndConfirm(prepared);

    // One write: the create, stating its initialization. No push of any kind, ever.
    expect(writesOf(github)).toEqual(["createRepository"]);
    expect(github.createRequests).toEqual([{ target: "acme/fixture", autoInit: true }]);
    expect(push).not.toHaveBeenCalled();

    // The head reported is the one GitHub initialized, read back; the tree is GitHub's alone.
    const head = await remoteHead(github);
    const remote = github.repository("acme", "fixture")!;
    expect((await git(remote.bare, ["ls-tree", "-r", "--name-only", head])).stdout.trim().split("\n")).toEqual(["README.md"]);
    const result = harness.cp.artifacts.latest<RepoFactoryResult>(runId, "REPO_FACTORY_RESULT")?.content;
    expect(result?.bootstrapVerification).toEqual([{ commandId: "clean-tree", repositoryIdentity: IDENTITY, exactHead: head, status: "PASS" }]);
    expect(result?.externalWriteReceipts.map((receipt) => receipt.operationId)).toEqual(["create-repository:fixture"]);
    expect(result?.repositories).toEqual([expect.objectContaining({ identity: IDENTITY, defaultBranch: "main", createdBranches: [] })]);
    const checkout = attemptCheckoutPath(join(prepared.workRoot, runId), "primary", 1);
    expect((await git(checkout, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    // No marker: the bootstrap content file is in no planned output, no tree and no result.
    expect(existsSync(join(checkout, BOOTSTRAP_CONTENT_FILE))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(BOOTSTRAP_CONTENT_FILE);
    expect(JSON.stringify(final)).not.toContain(BOOTSTRAP_CONTENT_FILE);

    // The provider receipt is GitHub's answer after the create: this create's node id, the
    // initialized default branch and its head.
    const ledger = ledgerOf(join(prepared.workRoot, runId));
    expect(ledger.pending).toEqual([]);
    expect(ledger.receipts.map((receipt) => receipt.observed)).toEqual([
      { nodeId: remote.nodeId, fullName: "acme/fixture", visibility: "public", defaultBranch: "main", initializedHead: head },
    ]);

    // G0a: the activation names the CommitLore it did not observe, before and after the CONFIRM.
    expect(beforeConfirm["warnings"]).toEqual([{ commitlore: "NOT_OBSERVED", mode: "preferred" }]);
    expect(final).toMatchObject({ projectId: "c5-create-only", ceoConfirm: { decision: "CONFIRM" } });
    expect(final["warnings"]).toEqual([{ commitlore: "NOT_OBSERVED", mode: "preferred" }]);
  });

  it("W2: a repository already at the name is refused, not adopted, before any write — at the runner and in the producer", async () => {
    const prepared = await prepare("c5-existing");
    await prepared.github.seedForeign("acme", "fixture");
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApproval(prepared) });
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.RESOURCE_COLLISION,
      evidence: { stage: "precondition", refusal: "RESOURCE_COLLISION" },
    });
    expect(prepared.github.writes).toEqual([]);
    expect(prepared.harness.cp.bootstrapApplications.get(prepared.runId)).toBeNull();
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();

    // The producer's own check, with no runner in front of it: WRONG_TARGET, nothing written.
    const { workDir, github } = sandbox();
    await github.seedForeign("acme", "fixture");
    const produced = await produce(workDir, github, createOnlyOperations());
    expect(produced, JSON.stringify(produced)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.RESOURCE_COLLISION,
      evidence: { refusal: "WRONG_TARGET", failedOperationId: "create-repository:fixture" },
    });
    expect(github.writes).toEqual([]);
  });

  it("W3a: a create sent and never answered, with nothing at the target, stays IN_DOUBT and is not sent again", async () => {
    const prepared = await prepare("c5-unanswered");
    const input = { ...prepared.input, ownerApproval: ownerApproval(prepared) };
    prepared.github.failNext = "createRepository";
    const first = await prepared.runner.produceAndActivate(input);
    expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, evidence: { stage: "production", refusal: "REMOTE_REFUSED" } });
    for (const attempt of [2, 3]) {
      const again = await prepared.runner.produceAndActivate(input);
      expect(again, `${attempt}: ${JSON.stringify(again)}`).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
        evidence: { refusal: "UNCONFIRMED_PENDING_REQUEST" },
      });
    }
    expect(writesOf(prepared.github)).toEqual(["createRepository"]);
    expect(prepared.github.createRequests).toHaveLength(1);
    expect(prepared.github.repository("acme", "fixture")).toBeUndefined();
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();
    expect(prepared.harness.cp.bootstrapApplications.get(prepared.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
  });

  it("W3b: a create GitHub ran whose answer was lost is STRANDED: not adopted, not sent again", async () => {
    const prepared = await prepare("c5-lost-answer");
    const input = { ...prepared.input, ownerApproval: ownerApproval(prepared) };
    prepared.github.failAfter = { method: "createRepository", mode: "response" };
    const first = await prepared.runner.produceAndActivate(input);
    expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, evidence: { stage: "production", refusal: "REMOTE_REFUSED" } });
    expect(await remoteHead(prepared.github)).toMatch(/^[0-9a-f]{40}$/);
    const second = await prepared.runner.produceAndActivate(input);
    expect(second, JSON.stringify(second)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_STRANDED,
      evidence: { cause: "ATTRIBUTION_UNCERTAIN" },
    });
    const third = await prepared.runner.produceAndActivate(input);
    expect(third.allowed).toBe(false);
    expect(writesOf(prepared.github)).toEqual(["createRepository"]);
    expect(prepared.github.createRequests).toHaveLength(1);
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();
  });

  describe("W4: an initialized head that cannot be confirmed is not success", () => {
    const cases: Array<[string, (github: InitializingGitHub) => void, Record<string, unknown>]> = [
      ["GitHub initialized nothing", (github) => { github.ignoreAutoInit = true; }, { reasonCode: ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, refusal: "INITIALIZED_HEAD_UNOBSERVED" }],
      ["GitHub initialized a branch other than the plan's default", (github) => { github.initialBranch = "master"; }, { reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, refusal: "INITIALIZED_BRANCH_MISMATCH" }],
      ["the head is not GitHub's initialization commit", (github) => { github.commitOnTopOfInit = true; }, { reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, refusal: "INITIALIZED_HEAD_HAS_PARENT" }],
      [
        "the default branch GitHub reports reads as absent",
        (github) => { vi.spyOn(github, "observeBranch").mockResolvedValueOnce(null); },
        { reasonCode: ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, refusal: "INITIALIZED_HEAD_UNOBSERVED" },
      ],
      [
        "the name is reused before the initialization is read",
        (github) => onInitializationRead(github, (changed) => changed.replace("acme", "fixture")),
        { reasonCode: ReasonCode.RESOURCE_COLLISION, refusal: "WRONG_TARGET" },
      ],
      [
        "the repository is gone before the initialization is read",
        (github) => onInitializationRead(github, (changed) => changed.remove("acme", "fixture")),
        { reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, refusal: "RESUMED_RESOURCE_ABSENT" },
      ],
      [
        "the repository turns private before the initialization is read",
        (github) => onInitializationRead(github, (changed) => { changed.repository("acme", "fixture")!.visibility = "private"; }),
        { reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, refusal: "VISIBILITY_MISMATCH" },
      ],
      [
        "the branch read is not answered",
        (github) => { vi.spyOn(github, "observeBranch").mockRejectedValueOnce(new Error("HTTP 502 injected on observeBranch")); },
        { reasonCode: ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, refusal: "REMOTE_REFUSED" },
      ],
    ];
    for (const [name, arrange, expected] of cases) {
      it(name, async () => {
        const { workDir, github } = sandbox();
        arrange(github);
        const persisted: RepoFactoryResult[] = [];
        const produced = await produce(workDir, github, createOnlyOperations(), (result) => persisted.push(result));
        expect(produced, JSON.stringify(produced)).toMatchObject({
          allowed: false,
          reasonCode: expected["reasonCode"],
          evidence: { refusal: expected["refusal"], failedOperationId: "create-repository:fixture", completedOperationIds: [] },
        });
        expect(persisted).toEqual([]);
        expect(writesOf(github)).toEqual(["createRepository"]);
        // The create's answer is kept as the pending write's identity, so a retry adopts it rather than creating again.
        expect(ledgerOf(workDir).receipts).toEqual([]);
      });
    }

    it("a retry after an unanswered branch read adopts the create by its node id and reads the head again: still one create", async () => {
      const { workDir, github } = sandbox();
      vi.spyOn(github, "observeBranch").mockRejectedValueOnce(new Error("HTTP 502 injected on observeBranch"));
      expect((await produce(workDir, github, createOnlyOperations())).allowed).toBe(false);
      const retried = await produce(workDir, github, createOnlyOperations());
      if (!retried.allowed) throw new Error(`${retried.reasonCode}: ${retried.message} ${JSON.stringify(retried.evidence)}`);
      expect(retried.value.bootstrapVerification[0]?.exactHead).toBe(await remoteHead(github));
      expect(github.createRequests).toHaveLength(1);
      expect(writesOf(github)).toEqual(["createRepository"]);
    });
  });

  it("W5 (control): a push-mode plan still requires the producer's own pushed head — a default branch it did not push is refused", async () => {
    const { workDir, github } = sandbox();
    github.initializeEvenUnasked = true;
    const push = vi.spyOn(github, "pushBranch");
    const produced = await produce(workDir, github, [createOnlyOperations()[0]!, PUSH].map((operation) =>
      operation.resourceType === "repository" ? { ...operation, desiredState: { visibility: "public" } } : operation,
    ));
    expect(produced, JSON.stringify(produced)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.RESOURCE_COLLISION,
      evidence: { refusal: "UNRECEIPTED_RESOURCE", failedOperationId: "push-default-branch:fixture" },
    });
    expect(push).not.toHaveBeenCalled();
    expect(writesOf(github)).toEqual(["createRepository"]);
    // A push-mode create never asks GitHub to initialize.
    expect(github.createRequests.map((request) => request.autoInit === true)).toEqual([false]);
  });

  it("W6a: no direct push in create-only mode — a create-only plan that also pushes is refused before any GitHub call", async () => {
    const ops = [...createOnlyOperations(), PUSH];
    const manifest = manifestFor("c5-push-too");
    const planned = plannedBootstrapOutputs(
      { runId: "run_c5_push_too", planArtifact: { digest: "probe", content: bootstrapPlan(manifest, { operations: ops }) } },
      manifest,
    );
    expect(planned, JSON.stringify(planned)).toMatchObject({ allowed: false, evidence: { refusal: "UNSUPPORTED_PLAN_SHAPE", operationId: PUSH.operationId } });
    const { workDir, github } = sandbox();
    const push = vi.spyOn(github, "pushBranch");
    const produced = await produce(workDir, github, ops);
    expect(produced, JSON.stringify(produced)).toMatchObject({ allowed: false, evidence: { refusal: "UNSUPPORTED_PLAN_SHAPE", operationId: PUSH.operationId } });
    expect(push).not.toHaveBeenCalled();
    expect(github.writes).toEqual([]);
    expect(github.reads).toEqual([]);
  });

  it("W6b: the production port states the initialization in the create request, and the attempt's guard is asked before it", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client: GitHubClient = {
      async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
        calls.push(body === undefined ? { method, path } : { method, path, body });
        if (`${method} ${path}` === "GET users/acme") return { login: "acme", type: "Organization" } as T;
        if (`${method} ${path}` === "POST orgs/acme/repos") return { node_id: "R_kgDOnew", full_name: "acme/fixture", visibility: "public", default_branch: "main" } as T;
        throw acpError(ReasonCode.NOT_FOUND, "Not Found", { status: 404 });
      },
    };
    const port = createBootstrapGitHubWritePort(client, async () => {
      throw new Error("a create sends no git command");
    });
    const asked: BootstrapWriteRequest[] = [];
    await runUnderWriteGuard({ beforeRequest: (request) => { asked.push(request); } }, () =>
      port.createRepository({ owner: "acme", name: "fixture" }, "public", "repo-factory:marker", true),
    );
    expect(asked).toEqual([{ kind: "api", method: "POST", target: "orgs/acme/repos" }]);
    expect(calls.at(-1)).toEqual({
      method: "POST",
      path: "orgs/acme/repos",
      body: { name: "fixture", description: "repo-factory:marker", private: false, visibility: "public", auto_init: true },
    });
  });

  it("W7: the owner's approval binds owner, visibility, plan digest and the operations — the initialization included", async () => {
    const prepared = await prepare("c5-approval");
    const withoutInit = createOnlyOperations().map((operation) => ({ ...operation, desiredState: { visibility: "public" } }));
    const renamed = createOnlyOperations("github:acme/renamed");
    const privateReceipt = ownerApproval(prepared, { visibility: "private" });
    for (const [name, approval] of [
      ["a receipt for another visibility", privateReceipt],
      ["a receipt for the create without its initialization", ownerApproval(prepared, { operations: withoutInit })],
      ["a receipt for another repository name", ownerApproval(prepared, { operations: renamed })],
    ] as const) {
      const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: approval });
      expect(refused, `${name}: ${JSON.stringify(refused)}`).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { stage: "approval", refusal: "APPROVAL_MISMATCH" },
      });
      noGitHubCall(prepared);
    }
    // The approval presented for another visibility than the plan's create: refused before the receipt is read.
    const presented = await prepared.runner.produceAndActivate({
      ...prepared.input,
      ownerApproval: { ...privateReceipt, visibility: "private" },
    });
    expect(presented, JSON.stringify(presented)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: { stage: "precondition", refusal: "VISIBILITY_MISMATCH" },
    });
    noGitHubCall(prepared);
  });

  it("operations after a create-only create apply to the initialized default branch, resume on its receipted head, and push nothing", async () => {
    const { workDir, github } = sandbox();
    const ops = [
      ...createOnlyOperations(),
      { operationId: "protect-default-branch:fixture", resourceType: "branch-protection", resourceIdentity: `${IDENTITY}#main`, desiredState: PROTECTION },
    ];
    github.failNext = "protectBranch";
    const first = await produce(workDir, github, ops);
    expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, evidence: { refusal: "REMOTE_REFUSED", completedOperationIds: ["create-repository:fixture"] } });
    const resumed = await produce(workDir, github, ops);
    if (!resumed.allowed) throw new Error(`${resumed.reasonCode}: ${resumed.message} ${JSON.stringify(resumed.evidence)}`);
    expect(resumed.value.bootstrapVerification[0]?.exactHead).toBe(await remoteHead(github));
    expect(writesOf(github)).toEqual(["createRepository", "protectBranch", "protectBranch"]);
    expect(github.repository("acme", "fixture")?.protections.get("main")).toEqual(PROTECTION);

    // A receipted initialized head that has since moved is drift, not a new head to accept.
    const remote = github.repository("acme", "fixture")!;
    const moved = tempDir("acp-c5-moved-");
    await git(moved, ["init", "-q", "-b", "main"]);
    await git(moved, ["fetch", "-q", remote.bare, "refs/heads/main"]);
    await git(moved, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    writeFileSync(join(moved, "LATER.md"), "later\n");
    await git(moved, ["add", "LATER.md"]);
    await git(moved, ["-c", "user.email=a@example.com", "-c", "user.name=someone", "commit", "-q", "-m", "later"]);
    await git(moved, ["push", "-q", remote.bare, "HEAD:refs/heads/main"]);
    // The successful run's checkout stays where it is; a later run of the same operation is refused at
    // it, so it is removed here to reach GitHub.
    rmSync(join(workDir, "repositories", "primary"), { recursive: true, force: true });
    const drifted = await produce(workDir, github, ops);
    expect(drifted, JSON.stringify(drifted)).toMatchObject({ allowed: false, evidence: { refusal: "RESUMED_RESOURCE_DRIFTED", failedOperationId: "create-repository:fixture" } });
    expect(github.createRequests).toHaveLength(1);
  });

  it("a create-only receipt that records no initialized head is not resumed on", async () => {
    const { workDir, github } = sandbox();
    const produced = await produce(workDir, github, createOnlyOperations());
    if (!produced.allowed) throw new Error(`${produced.reasonCode}: ${produced.message}`);
    const path = join(workDir, "github-ledger", "primary.json");
    const ledger = JSON.parse(readFileSync(path, "utf8")) as { receipts: Array<{ observed: Record<string, unknown> }> };
    for (const receipt of ledger.receipts) delete receipt.observed["initializedHead"];
    writeFileSync(path, JSON.stringify(ledger));
    rmSync(join(workDir, "repositories", "primary"), { recursive: true, force: true });
    const refused = await produce(workDir, github, createOnlyOperations());
    expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "LEDGER_CORRUPT", failedOperationId: "create-repository:fixture" } });
    expect(github.createRequests).toHaveLength(1);
  });
});
