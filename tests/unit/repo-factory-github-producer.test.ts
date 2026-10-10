import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { PROJECT_MANIFEST_SCHEMA_ID, assertPortableManifest } from "../../src/contracts/manifest.ts";
import { parseRepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import {
  produceRepoFactoryResult,
  repositoryCheckoutPath,
  type RepoFactoryPlanFixture,
} from "../../src/bootstrap/repo-factory-producer.ts";
import { writeWithheldRequest } from "../../src/bootstrap/bootstrap-approval-anchor.ts";
import { git } from "../../src/git/git.ts";
import { withholdPending } from "../helpers/bootstrap-runner.ts";
import { FakeGitHub, type Protection } from "../helpers/fake-github-write-port.ts";

/**
 * Issue #246 — the producer performs the GitHub operations its plan calls for, through an
 * injected port, and receipts what GitHub answered rather than what the plan said.
 *
 * The double (`tests/helpers/fake-github-write-port.ts`) is a GitHub with real git underneath: each repository it "creates" is a bare
 * repository in the sandbox, so a push moves a real ref and a commit SHA in a receipt is a SHA a
 * real `git rev-parse` produced. Node ids are minted by the double, never by the plan, which is
 * what lets these tests tell a receipted value from a copied one.
 *
 * Every refusal below asserts the double's write log. A refusal that still wrote is the defect
 * this producer exists to avoid, and "allowed: false" alone cannot see it.
 */

const sandboxes: string[] = [];
const makeSandbox = (): { workDir: string; github: FakeGitHub } => {
  const sandbox = mkdtempSync(join(tmpdir(), "acp-246-github-"));
  sandboxes.push(sandbox);
  return { workDir: join(sandbox, "workdir"), github: new FakeGitHub(sandbox) };
};

afterEach(async () => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const IDENTITY = "github:acme/fixture";
const PROTECTION: Protection = {
  requiredStatusChecks: { strict: true, contexts: ["project-ci"] },
  enforceAdmins: true,
  requiredApprovingReviewCount: null,
  allowForcePushes: false,
  allowDeletions: false,
};

const operations = () => [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository" as const,
    resourceIdentity: IDENTITY,
    desiredState: { visibility: "public" as const },
  },
  {
    operationId: "push-default-branch:fixture",
    resourceType: "branch" as const,
    resourceIdentity: `${IDENTITY}#main`,
  },
  {
    operationId: "set-default-branch:fixture",
    resourceType: "setting" as const,
    resourceIdentity: `${IDENTITY}#default-branch`,
    desiredState: { defaultBranch: "main" },
  },
  {
    operationId: "protect-default-branch:fixture",
    resourceType: "branch-protection" as const,
    resourceIdentity: `${IDENTITY}#main`,
    desiredState: PROTECTION,
  },
];

type Operation = ReturnType<typeof operations>[number];

const githubPlan = (ops: Operation[] = operations()) =>
  ({
    runId: "run_bootstrap_246",
    bootstrapOperationId: "bootstrap_246",
    requestDigest: "sha256:" + "a".repeat(64),
    planDigest: "sha256:" + "b".repeat(64),
    projectManifestDigest: "sha256:" + "c".repeat(64),
    repositoryRole: "primary",
    defaultBranch: "main",
    verificationCommandId: "local-clean-tree",
    verificationKind: "CLEAN_TREE",
    githubOperations: ops,
  }) as unknown as RepoFactoryPlanFixture;

/** The triples activation matches receipts against — the approved PLAN artifact's own shape. */
const approvedTriples = (ops: Operation[]) =>
  ops.map(({ operationId, resourceType, resourceIdentity }) => ({ operationId, resourceType, resourceIdentity }));

const authority = (overrides: Partial<{ owner: string; visibility: string; approvedOperations: unknown[] }> = {}) => ({
  owner: "acme",
  visibility: "public",
  approvedOperations: approvedTriples(operations()),
  ...overrides,
});

const produce = (
  workDir: string,
  github: FakeGitHub,
  options: { plan?: RepoFactoryPlanFixture; authority?: ReturnType<typeof authority>; at?: string } = {},
) =>
  produceRepoFactoryResult({
    plan: options.plan ?? githubPlan(),
    workDir,
    clock: new ManualClock(options.at ?? "2026-10-02T00:00:00.000Z"),
    github: { port: github, authority: options.authority ?? authority() },
  } as Parameters<typeof produceRepoFactoryResult>[0]);

const ledgerPath = (workDir: string): string => join(workDir, "github-ledger", "primary.json");

interface LedgerReceipt {
  operationId: string;
  resourceType: string;
  resourceIdentity: string;
  repositoryNodeId: string;
  preexisting: boolean;
  beforeStateDigest: string | null;
  observed: Record<string, unknown>;
  createdAt: string;
  rereadAt: string;
}

const readLedger = (workDir: string): { bootstrapOperationId: string; receipts: LedgerReceipt[] } =>
  JSON.parse(readFileSync(ledgerPath(workDir), "utf8")) as { bootstrapOperationId: string; receipts: LedgerReceipt[] };

const evidenceOf = (decision: { allowed: boolean; evidence: Record<string, unknown> }) =>
  decision.evidence as Record<string, unknown>;

describe("repo factory producer performs planned GitHub operations (#246)", () => {
  it("performs each planned operation through the port and receipts what GitHub answered, not what the plan said", async () => {
    // RF-S14 arm:repository: the created repository's receipt is GitHub's re-read (its owner spelling, node id), not the plan's request.
    // RF-S14 arm:branch: the pushed branch's receipt is the head GitHub holds on re-read, not the commit this process made.
    const { workDir, github } = makeSandbox();
    // GitHub spells the owner its own way. A receipt that copied the plan would say `acme`.
    github.canonicalOwner = "Acme";

    const produced = await produce(workDir, github);
    if (!produced.allowed) throw new Error(`${produced.reasonCode}: ${produced.message} ${JSON.stringify(produced.evidence)}`);

    expect(github.writes.map((write) => write.method)).toEqual([
      "createRepository",
      "pushBranch",
      "setDefaultBranch",
      "protectBranch",
    ]);

    const parsed = parseRepoFactoryResult(produced.value);
    expect(parsed.allowed).toBe(true);
    const result = produced.value;
    expect(result.repositories).toEqual([
      expect.objectContaining({ role: "primary", identity: IDENTITY, defaultBranch: "main" }),
    ]);

    // Activation matches every receipt against the approved plan's triples and wants none
    // missing (activation.ts validateFactoryProvenance). No local receipt rides along.
    const triples = result.externalWriteReceipts.map(({ operationId, resourceType, resourceIdentity }) => ({
      operationId,
      resourceType,
      resourceIdentity,
    }));
    expect(triples).toEqual(approvedTriples(operations()));
    expect(result.externalWriteReceipts.every((receipt) => receipt.verified && receipt.rereadAt)).toBe(true);

    // The durable receipts carry GitHub's answers.
    const remote = github.repository("acme", "fixture");
    if (!remote) throw new Error("the double holds no repository");
    const ledger = readLedger(workDir);
    const byId = new Map(ledger.receipts.map((receipt) => [receipt.operationId, receipt]));
    expect(byId.get("create-repository:fixture")?.observed).toEqual({
      nodeId: remote.nodeId,
      fullName: "Acme/fixture",
      visibility: "public",
    });
    const remoteHead = (await git(remote.bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
    expect(byId.get("push-default-branch:fixture")?.observed).toEqual({ name: "main", headSha: remoteHead });
    expect(byId.get("set-default-branch:fixture")?.observed).toEqual({ defaultBranch: "main" });
    expect(byId.get("protect-default-branch:fixture")?.observed).toEqual(remote.protections.get("main"));
    for (const receipt of ledger.receipts) expect(receipt.repositoryNodeId).toBe(remote.nodeId);

    // The contract's digest is the digest of exactly that readback, so the two cannot drift.
    for (const receipt of result.externalWriteReceipts) {
      expect(receipt.afterStateDigest).toBe(digestOf(byId.get(receipt.operationId)?.observed));
    }

    // The verified head is the one GitHub has, and the proposed checkout really is at it.
    expect(result.bootstrapVerification).toEqual([
      { commandId: "local-clean-tree", repositoryIdentity: IDENTITY, exactHead: remoteHead, status: "PASS" },
    ]);
    const localHead = (await git(repositoryCheckoutPath(workDir, "primary"), ["rev-parse", "HEAD"])).stdout.trim();
    expect(localHead).toBe(remoteHead);
  });

  it("the produced identity satisfies the manifest's portable-remote rule, which a local identity still cannot (manifest.ts stays as it is)", async () => {
    const { workDir, github } = makeSandbox();
    const produced = await produce(workDir, github);
    if (!produced.allowed) throw new Error(`${produced.reasonCode}: ${produced.message}`);
    const manifest = (remote: string) => ({
      schema: PROJECT_MANIFEST_SCHEMA_ID,
      projectId: "fixture",
      repositories: [{ role: "primary", remote, manifestRoot: "." }],
      branchProfile: {
        longLived: ["main"],
        defaultBranch: "main",
        updateStrategy: "rebase_before_review",
        mergeStrategy: "merge_commit",
        releaseTagPolicy: "semver",
        releaseBranchCleanup: "keep",
      },
      verificationProfiles: { simple: [], standard: [], guarded: [] },
      verificationCommands: [],
      postMergeCommands: [],
      ciWorkflows: [],
      commitlore: { mode: "preferred" },
    });
    const identity = produced.value.repositories[0]?.identity ?? "";
    expect(assertPortableManifest(manifest(identity)).allowed).toBe(true);
    const local = assertPortableManifest(manifest("local:primary"));
    expect(local.allowed).toBe(false);
    expect(local.reasonCode).toBe(ReasonCode.MANIFEST_NOT_PORTABLE);
  });

  describe("an operation outside the approved plan is refused before any GitHub call", () => {
    it("refuses a planned operation the approval does not cover", async () => {
      // RF-S24: a planned write the approval does not cover is refused before any GitHub read or write.
      const { workDir, github } = makeSandbox();
      const produced = await produce(workDir, github, {
        authority: authority({ approvedOperations: approvedTriples(operations().slice(0, 3)) }),
      });
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(produced).refusal).toBe("OPERATION_NOT_IN_PLAN");
      expect(evidenceOf(produced).operationId).toBe("protect-default-branch:fixture");
      expect(github.writes).toEqual([]);
      expect(github.reads).toEqual([]);
      expect(existsSync(repositoryCheckoutPath(workDir, "primary"))).toBe(false);
    });

    it("refuses an approved operation whose executable form names a different resource", async () => {
      const { workDir, github } = makeSandbox();
      const approved = approvedTriples(operations());
      approved[3] = { ...approved[3]!, resourceIdentity: `${IDENTITY}#release` };
      const produced = await produce(workDir, github, { authority: authority({ approvedOperations: approved }) });
      expect(produced.allowed).toBe(false);
      expect(evidenceOf(produced).refusal).toBe("OPERATION_NOT_IN_PLAN");
      expect(github.writes).toEqual([]);
    });

    it("refuses when the approval covers an operation the plan would never perform", async () => {
      const { workDir, github } = makeSandbox();
      const produced = await produce(workDir, github, { plan: githubPlan(operations().slice(0, 3)) });
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(produced).refusal).toBe("APPROVED_OPERATION_NOT_PLANNED");
      expect(github.writes).toEqual([]);
    });

    it("refuses a resume ledger that names an operation the plan does not contain", async () => {
      const { workDir, github } = makeSandbox();
      github.failNext = "pushBranch";
      const first = await produce(workDir, github);
      expect(first.allowed).toBe(false);
      const ledger = readLedger(workDir);
      ledger.receipts.push({ ...ledger.receipts[0]!, operationId: "delete-repository:fixture" });
      writeFileSync(ledgerPath(workDir), JSON.stringify(ledger));
      github.writes.length = 0;

      const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
      expect(retry.allowed).toBe(false);
      expect(retry.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(retry).refusal).toBe("OPERATION_NOT_IN_PLAN");
      expect(github.writes).toEqual([]);
    });
  });

  describe("owner and visibility mismatches", () => {
    it("refuses a plan that targets an owner the approval does not name, with no GitHub call", async () => {
      const { workDir, github } = makeSandbox();
      const produced = await produce(workDir, github, { authority: authority({ owner: "someone-else" }) });
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(produced).refusal).toBe("OWNER_MISMATCH");
      expect(evidenceOf(produced).operationId).toBe("create-repository:fixture");
      expect(github.writes).toEqual([]);
      expect(github.reads).toEqual([]);
    });

    it("refuses a later operation aimed at another owner, even when the repository's own owner is approved", async () => {
      const { workDir, github } = makeSandbox();
      const ops = operations();
      ops[3] = { ...ops[3]!, resourceIdentity: "github:elsewhere/fixture#main" };
      const produced = await produce(workDir, github, {
        plan: githubPlan(ops),
        authority: authority({ approvedOperations: approvedTriples(ops) }),
      });
      expect(produced.allowed).toBe(false);
      expect(evidenceOf(produced).refusal).toBe("OWNER_MISMATCH");
      expect(evidenceOf(produced).operationId).toBe("protect-default-branch:fixture");
      expect(github.writes).toEqual([]);
      expect(github.reads).toEqual([]);
    });

    it("refuses a plan whose repository visibility differs from the approved visibility, with no GitHub call", async () => {
      const { workDir, github } = makeSandbox();
      const ops = operations();
      ops[0] = { ...ops[0]!, desiredState: { visibility: "private" } } as unknown as Operation;
      const produced = await produce(workDir, github, {
        plan: githubPlan(ops),
        authority: authority({ approvedOperations: approvedTriples(ops) }),
      });
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(produced).refusal).toBe("VISIBILITY_MISMATCH");
      expect(github.writes).toEqual([]);
      expect(github.reads).toEqual([]);
    });

    it("refuses a public repository when the approval covers only a private one, with no GitHub call", async () => {
      // RF-S25 arm:visibility: exposure cannot exceed what the approval names. The plan asks for a
      // public repository and the approval says private, so nothing is read or written.
      // That the approval has to be the owner's, never Hermes', is witnessed at the runner.
      const { workDir, github } = makeSandbox();
      const produced = await produce(workDir, github, { authority: authority({ visibility: "private" }) });
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(produced)).toMatchObject({
        refusal: "VISIBILITY_MISMATCH",
        planned: "public",
        approved: "private",
      });
      expect(github.writes).toEqual([]);
      expect(github.reads).toEqual([]);
    });

    it("stops after a create that GitHub reports under a different owner, and receipts nothing as success", async () => {
      const { workDir, github } = makeSandbox();
      github.createUnderOwner = "octocat";
      const produced = await produce(workDir, github);
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
      expect(evidenceOf(produced).refusal).toBe("WRONG_TARGET");
      // GitHub's own answer, so an operator can find what was made.
      expect(evidenceOf(produced).observed).toEqual(expect.objectContaining({ fullName: "octocat/fixture" }));
      expect(github.writes.map((write) => write.method)).toEqual(["createRepository"]);
      expect(existsSync(ledgerPath(workDir)) ? readLedger(workDir).receipts : []).toEqual([]);
    });

    it("stops after a create that GitHub reports with a different visibility", async () => {
      const { workDir, github } = makeSandbox();
      github.createWithVisibility = "private";
      const produced = await produce(workDir, github);
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(produced).refusal).toBe("VISIBILITY_MISMATCH");
      expect(github.writes.map((write) => write.method)).toEqual(["createRepository"]);
    });

    it("refuses to resume onto a receipted repository whose visibility has since changed, with no write", async () => {
      const { workDir, github } = makeSandbox();
      github.failNext = "pushBranch";
      expect((await produce(workDir, github)).allowed).toBe(false);
      const remote = github.repository("acme", "fixture");
      if (!remote) throw new Error("no repository");
      remote.visibility = "private";
      github.writes.length = 0;

      const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
      expect(retry.allowed).toBe(false);
      expect(retry.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(evidenceOf(retry).refusal).toBe("VISIBILITY_MISMATCH");
      expect(github.writes).toEqual([]);
    });
  });

  describe("wrong target — an existing repository is ours only if a receipt's node id says so", () => {
    it("refuses a same-named repository that exists with no receipt from this operation, and writes nothing", async () => {
      // RF-S15: an unrelated repository of the same name is RESOURCE_COLLISION, and nothing is written.
      const { workDir, github } = makeSandbox();
      const foreign = await github.seedForeign("acme", "fixture");
      const produced = await produce(workDir, github);
      expect(produced.allowed).toBe(false);
      expect(produced.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
      expect(evidenceOf(produced).refusal).toBe("WRONG_TARGET");
      expect(evidenceOf(produced).observedNodeId).toBe(foreign.nodeId);
      // No write of ours was ever pending, so this is not an indeterminate outcome: it is foreign.
      expect(evidenceOf(produced).indeterminate).toBeUndefined();
      expect(github.writes).toEqual([]);
    });

    it("refuses to resume onto a repository whose name was reused after our receipt — node id differs — and writes nothing", async () => {
      // RF-S15: the same on resume: a reused name with another node id is a collision, and nothing is written.
      const { workDir, github } = makeSandbox();
      github.failNext = "pushBranch";
      expect((await produce(workDir, github)).allowed).toBe(false);
      const ours = readLedger(workDir).receipts.find((receipt) => receipt.resourceType === "repository");
      const replacement = await github.replace("acme", "fixture");
      github.writes.length = 0;

      const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
      expect(retry.allowed).toBe(false);
      expect(retry.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
      expect(evidenceOf(retry).refusal).toBe("WRONG_TARGET");
      expect(evidenceOf(retry).recordedNodeId).toBe(ours?.observed.nodeId);
      expect(evidenceOf(retry).observedNodeId).toBe(replacement.nodeId);
      expect(github.writes).toEqual([]);
    });
  });

  describe("partial failure leaves exact receipts and a resumable state, never a rollback", () => {
    it("records what succeeded, stops at the failure, and the retry performs only what is left", async () => {
      // RF-S16 arm:single-repository: retries across one repository's operations. This producer creates one
      // repository by construction, so the scenario itself is judged in repo-factory (REPO_FACTORY_EXTERNAL_EVIDENCE).
      const { workDir, github } = makeSandbox();
      github.failNext = "protectBranch";
      const first = await produce(workDir, github);
      expect(first.allowed).toBe(false);
      expect(first.reasonCode).toBe(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT);
      const evidence = evidenceOf(first);
      expect(evidence.refusal).toBe("REMOTE_REFUSED");
      expect(evidence.failedOperationId).toBe("protect-default-branch:fixture");
      expect(evidence.completedOperationIds).toEqual([
        "create-repository:fixture",
        "push-default-branch:fixture",
        "set-default-branch:fixture",
      ]);
      expect(evidence.rollback).toBe("none");
      expect(evidence.resumable).toBe(true);
      // Exactly the attempted writes, and no compensating one.
      expect(github.writes.map((write) => write.method)).toEqual([
        "createRepository",
        "pushBranch",
        "setDefaultBranch",
        "protectBranch",
      ]);
      expect(readLedger(workDir).receipts.map((receipt) => receipt.operationId)).toEqual(
        evidence.completedOperationIds,
      );
      const pushed = readLedger(workDir).receipts.find((receipt) => receipt.resourceType === "branch");
      // The local checkout is disposable; the ledger beside it is the resume state.
      expect(existsSync(repositoryCheckoutPath(workDir, "primary"))).toBe(false);

      github.writes.length = 0;
      // #246 C5, review C5I-R1-02 — a protection sent and never answered stays in doubt with no request
      // made, until C3's withheld-request record proves this intent was never sent.
      expect(await produce(workDir, github, { at: "2026-10-02T00:04:00.000Z" })).toMatchObject({
        allowed: false,
        evidence: { refusal: "UNCONFIRMED_PENDING_REQUEST", resourceType: "branch-protection" },
      });
      expect(github.writes).toEqual([]);
      withholdPending(workDir);
      const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
      if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message} ${JSON.stringify(retry.evidence)}`);
      expect(github.writes.map((write) => write.method)).toEqual(["protectBranch"]);
      // The resumed checkout is the commit GitHub already has, fetched — not a new commit.
      expect(retry.value.bootstrapVerification[0]?.exactHead).toBe(pushed?.observed.headSha);
      expect(parseRepoFactoryResult(retry.value).allowed).toBe(true);
      expect(retry.value.externalWriteReceipts.map((receipt) => receipt.operationId)).toEqual(
        operations().map((operation) => operation.operationId),
      );
    });

    it("a failure at the push leaves only the repository receipted, and the retry pushes a fresh commit to it", async () => {
      // RF-S16 arm:single-repository (see the test above).
      const { workDir, github } = makeSandbox();
      github.failNext = "pushBranch";
      const first = await produce(workDir, github);
      expect(first.allowed).toBe(false);
      expect(evidenceOf(first).completedOperationIds).toEqual(["create-repository:fixture"]);
      expect(readLedger(workDir).receipts.map((receipt) => receipt.resourceType)).toEqual(["repository"]);

      github.writes.length = 0;
      // #246 C5, review C5I-R1-02 — the push's intent is pending: in doubt until proven never sent.
      expect(await produce(workDir, github, { at: "2026-10-02T00:04:00.000Z" })).toMatchObject({
        allowed: false,
        evidence: { refusal: "UNCONFIRMED_PENDING_REQUEST", resourceType: "branch" },
      });
      expect(github.writes).toEqual([]);
      withholdPending(workDir);
      const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
      if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message}`);
      expect(github.writes.map((write) => write.method)).toEqual(["pushBranch", "setDefaultBranch", "protectBranch"]);
    });

    it("a readback that disagrees with what was asked is a failure, not a receipt", async () => {
      const { workDir, github } = makeSandbox();
      // The write call returns, and GitHub keeps something weaker than was requested.
      github.keepProtection = (requested) => ({ ...(requested as Protection), enforceAdmins: false });
      const produced = await produce(workDir, github);
      expect(produced.allowed).toBe(false);
      expect(evidenceOf(produced).refusal).toBe("REREAD_MISMATCH");
      expect(evidenceOf(produced).failedOperationId).toBe("protect-default-branch:fixture");
      expect(readLedger(workDir).receipts.map((receipt) => receipt.operationId)).not.toContain(
        "protect-default-branch:fixture",
      );
    });
  });

  it("reports a default branch only once GitHub reports it, even when no operation set it", async () => {
    const { workDir, github } = makeSandbox();
    github.pushSetsDefault = false;
    const ops = operations().filter((operation) => operation.resourceType !== "setting");
    const produced = await produce(workDir, github, {
      plan: githubPlan(ops),
      authority: authority({ approvedOperations: approvedTriples(ops) }),
    });
    expect(produced.allowed).toBe(false);
    expect(evidenceOf(produced).refusal).toBe("REREAD_MISMATCH");
    expect(evidenceOf(produced).observed).toBeNull();
    expect(evidenceOf(produced).reported).toBe("main");
  });

  it("a throw inside the GitHub half still removes its own checkout, so the operation stays retryable (#871's rule)", async () => {
    const { workDir, github } = makeSandbox();
    // The ledger's scratch file cannot be opened: the first verified write's `record` throws.
    mkdirSync(join(workDir, "github-ledger", "primary.json.partial"), { recursive: true });
    await expect(produce(workDir, github)).rejects.toMatchObject({ code: "EISDIR" });
    expect(existsSync(repositoryCheckoutPath(workDir, "primary"))).toBe(false);
  });

  describe("retry safety", () => {
    it("re-running a finished operation after the local checkout is lost writes nothing and receipts the same resources", async () => {
      const { workDir, github } = makeSandbox();
      const first = await produce(workDir, github);
      if (!first.allowed) throw new Error(`${first.reasonCode}: ${first.message}`);
      rmSync(repositoryCheckoutPath(workDir, "primary"), { recursive: true, force: true });
      github.writes.length = 0;

      const again = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
      if (!again.allowed) throw new Error(`${again.reasonCode}: ${again.message}`);
      expect(github.writes).toEqual([]);
      expect(again.value.bootstrapVerification[0]?.exactHead).toBe(first.value.bootstrapVerification[0]?.exactHead);
      expect(again.value.externalWriteReceipts.map((receipt) => receipt.afterStateDigest)).toEqual(
        first.value.externalWriteReceipts.map((receipt) => receipt.afterStateDigest),
      );
    });

    it("refuses a ledger written for a different bootstrap operation rather than resuming someone else's writes", async () => {
      const { workDir, github } = makeSandbox();
      github.failNext = "pushBranch";
      expect((await produce(workDir, github)).allowed).toBe(false);
      github.writes.length = 0;
      const other = { ...githubPlan(), bootstrapOperationId: "bootstrap_other" } as RepoFactoryPlanFixture;
      const produced = await produce(workDir, github, { plan: other, at: "2026-10-02T00:05:00.000Z" });
      expect(produced.allowed).toBe(false);
      expect(evidenceOf(produced).refusal).toBe("LEDGER_FOREIGN");
      expect(github.writes).toEqual([]);
    });
  });

  it("still refuses a GitHub plan when no port is supplied — the #246 boundary for callers that cannot write", async () => {
    const { workDir } = makeSandbox();
    const produced = await produceRepoFactoryResult({ plan: githubPlan(), workDir });
    expect(produced.allowed).toBe(false);
    expect(produced.reasonCode).toBe(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT);
    expect(produced.allowed ? "" : produced.message).toMatch(/GitHub write port/);
    expect(existsSync(repositoryCheckoutPath(workDir, "primary"))).toBe(false);
  });
});

/**
 * PR #1043 review witnesses (RF1043-02). A write that reached GitHub and whose answer — or the
 * read after it, or the ledger line recording it — was lost must not leave the operation unable
 * to resume, nor make it write again. These use a plan without branch protection so the same
 * cases run unchanged against the reviewed head (afd93586), where each of them fails.
 */
describe("PR #1043 review witnesses — a write GitHub accepted is recoverable after its answer is lost", () => {
  const threeOperations = () => operations().filter((operation) => operation.resourceType !== "branch-protection");
  const threeOperationPlan = () => githubPlan(threeOperations());
  const threeOperationAuthority = () => authority({ approvedOperations: approvedTriples(threeOperations()) });
  const attempt = (workDir: string, github: FakeGitHub, at: string) =>
    produce(workDir, github, { plan: threeOperationPlan(), authority: threeOperationAuthority(), at });

  it("a create whose read-back failed is adopted on retry by the node id GitHub returned, not refused as someone else's", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "createRepository", mode: "readback" };
    const first = await attempt(workDir, github, "2026-10-02T00:00:00.000Z");
    expect(first.allowed).toBe(false);
    const created = github.repository("acme", "fixture");
    if (!created) throw new Error("the create did not reach the double");

    github.writes.length = 0;
    const retry = await attempt(workDir, github, "2026-10-02T00:05:00.000Z");
    if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message} ${JSON.stringify(retry.evidence)}`);
    expect(github.writes.map((write) => write.method)).not.toContain("createRepository");
    expect(github.repository("acme", "fixture")?.nodeId).toBe(created.nodeId);
  });

  it("a create whose own response was lost is reported as indeterminate on retry — explicitly, with no write — not adopted by its public marker", async () => {
    // Round 1 adopted this by the description marker; round 2 (RF1043-06) showed a replacement
    // can carry that public marker, so without a recorded node id the outcome stays unresolved.
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "createRepository", mode: "response" };
    const first = await attempt(workDir, github, "2026-10-02T00:00:00.000Z");
    expect(first.allowed).toBe(false);
    if (!github.repository("acme", "fixture")) throw new Error("the create did not reach the double");

    github.writes.length = 0;
    const retry = await attempt(workDir, github, "2026-10-02T00:05:00.000Z");
    expect(retry.allowed).toBe(false);
    expect(retry.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(evidenceOf(retry).indeterminate).toBe(true);
    expect(evidenceOf(retry).markerMatches).toBe(true);
    expect(github.writes).toEqual([]);
  });

  it("a push whose read-back failed is adopted on retry by the commit it pushed, not refused as an unreceipted branch", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "pushBranch", mode: "readback" };
    const first = await attempt(workDir, github, "2026-10-02T00:00:00.000Z");
    expect(first.allowed).toBe(false);
    const remote = github.repository("acme", "fixture");
    if (!remote) throw new Error("no repository");
    const pushed = (await git(remote.bare, ["rev-parse", "refs/heads/main"])).stdout.trim();

    github.writes.length = 0;
    const retry = await attempt(workDir, github, "2026-10-02T00:05:00.000Z");
    if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message} ${JSON.stringify(retry.evidence)}`);
    expect(github.writes.map((write) => write.method)).not.toContain("pushBranch");
    expect(retry.value.bootstrapVerification[0]?.exactHead).toBe(pushed);
  });

  it("a setting whose read-back failed is not written again on retry when GitHub already holds it", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "setDefaultBranch", mode: "readback" };
    const first = await attempt(workDir, github, "2026-10-02T00:00:00.000Z");
    expect(first.allowed).toBe(false);

    github.writes.length = 0;
    const retry = await attempt(workDir, github, "2026-10-02T00:05:00.000Z");
    if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message} ${JSON.stringify(retry.evidence)}`);
    expect(github.writes.map((write) => write.method)).not.toContain("setDefaultBranch");
  });

  it("a create whose receipt could not be written is adopted on retry, not refused as someone else's", async () => {
    const { workDir, github } = makeSandbox();
    const scratch = join(workDir, "github-ledger", "primary.json.partial");
    const observe = github.observeRepository.bind(github);
    let created = false;
    const create = github.createRepository.bind(github);
    github.createRepository = async (...args: Parameters<typeof create>) => {
      created = true;
      return create(...args);
    };
    // The create reaches GitHub and is read back; the ledger write that would receipt it fails.
    github.observeRepository = async (...args: Parameters<typeof observe>) => {
      const observed = await observe(...args);
      if (created) mkdirSync(scratch, { recursive: true });
      return observed;
    };
    await expect(attempt(workDir, github, "2026-10-02T00:00:00.000Z")).rejects.toMatchObject({ code: "EISDIR" });
    const repository = github.repository("acme", "fixture");
    if (!repository) throw new Error("the create did not reach the double");
    github.createRepository = create;
    github.observeRepository = observe;
    rmSync(scratch, { recursive: true, force: true });

    github.writes.length = 0;
    const retry = await attempt(workDir, github, "2026-10-02T00:05:00.000Z");
    if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message} ${JSON.stringify(retry.evidence)}`);
    expect(github.writes.map((write) => write.method)).not.toContain("createRepository");
    expect(github.repository("acme", "fixture")?.nodeId).toBe(repository.nodeId);
  });
});

describe("pending writes and readback fidelity (#1043 review follow-through)", () => {
  it("a create whose answer could not be recorded at all is reported as indeterminate on retry, with no write", async () => {
    const { workDir, github } = makeSandbox();
    const scratch = join(workDir, "github-ledger", "primary.json.partial");
    const create = github.createRepository.bind(github);
    // The create reaches GitHub; the ledger write that would record its answer fails.
    github.createRepository = async (...args: Parameters<typeof create>) => {
      const created = await create(...args);
      mkdirSync(scratch, { recursive: true });
      return created;
    };
    await expect(produce(workDir, github)).rejects.toMatchObject({ code: "EISDIR" });
    github.createRepository = create;
    rmSync(scratch, { recursive: true, force: true });
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(evidenceOf(retry).indeterminate).toBe(true);
    expect(github.writes).toEqual([]);
  });

  it("refuses a protection GitHub kept without `strict`, though every other field matches (RF1043-04)", async () => {
    const { workDir, github } = makeSandbox();
    github.keepProtection = (requested) => {
      const kept = requested as Protection;
      return { ...kept, requiredStatusChecks: { contexts: kept.requiredStatusChecks?.contexts ?? [], strict: false } };
    };
    const produced = await produce(workDir, github);
    expect(produced.allowed).toBe(false);
    expect(evidenceOf(produced).refusal).toBe("REREAD_MISMATCH");
    expect(evidenceOf(produced).failedOperationId).toBe("protect-default-branch:fixture");
  });

  it("a protection whose read-back failed is not written again on retry when GitHub already holds it", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "protectBranch", mode: "readback" };
    expect((await produce(workDir, github)).allowed).toBe(false);
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message}`);
    expect(github.writes).toEqual([]);
  });

  it("refuses — as indeterminate, with no write — a same-named repository whose description is not the marker its lost create carried", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "createRepository", mode: "response" };
    expect((await produce(workDir, github)).allowed).toBe(false);
    // The name now holds a repository the lost create's marker does not identify.
    await github.replace("acme", "fixture");
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(retry.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(evidenceOf(retry).refusal).toBe("WRONG_TARGET");
    expect(evidenceOf(retry).indeterminate).toBe(true);
    expect(evidenceOf(retry).markerMatches).toBe(false);
    expect(github.writes).toEqual([]);
  });

  it("refuses a same-named repository whose node id is not the one its create's response named", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "createRepository", mode: "readback" };
    expect((await produce(workDir, github)).allowed).toBe(false);
    expect(readLedger(workDir).receipts).toEqual([]);
    await github.replace("acme", "fixture");
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(evidenceOf(retry).refusal).toBe("WRONG_TARGET");
    expect(evidenceOf(retry).indeterminate).toBe(false);
    expect(github.writes).toEqual([]);
  });

  it("refuses to create again under a name whose create GitHub already answered, once that repository is gone", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "createRepository", mode: "readback" };
    expect((await produce(workDir, github)).allowed).toBe(false);
    github.remove("acme", "fixture");
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(evidenceOf(retry).refusal).toBe("RESUMED_RESOURCE_ABSENT");
    expect(github.writes).toEqual([]);
  });

  // #246 C5, review C5I-R1-02 — this row used to create again here. A create that left an intent and no
  // answer may still land, so GitHub showing no trace of it proves nothing: it stays in doubt and is not
  // sent again, unless C3's withheld-request record proves this exact intent was never sent.
  it("keeps a create that left an intent and no answer in doubt, and sends it again, under the same marker, only on proof it was withheld", async () => {
    const { workDir, github } = makeSandbox();
    github.failNext = "createRepository";
    expect((await produce(workDir, github)).allowed).toBe(false);
    const marker = readLedger(workDir) as unknown as { pending: Array<{ operationId: string; attemptedAt: string; marker: string | null }> };
    expect(marker.pending).toHaveLength(1);
    github.writes.length = 0;
    const unproven = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(unproven, JSON.stringify(unproven)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
      evidence: { refusal: "UNCONFIRMED_PENDING_REQUEST", indeterminate: true, failedOperationId: "create-repository:fixture" },
    });
    expect(github.writes).toEqual([]);

    const [intent] = marker.pending;
    if (intent === undefined) throw new Error("no pending create");
    writeWithheldRequest(workDir, {
      runId: "run_bootstrap_246",
      attempt: 1,
      operationId: intent.operationId,
      resourceType: "repository",
      attemptedAt: intent.attemptedAt,
      withheldAt: "2026-10-02T00:00:01.000Z",
      refusal: "CEO_ADMISSION_LOST",
    });
    const retry = await produce(workDir, github, { at: "2026-10-02T00:10:00.000Z" });
    if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message}`);
    expect(github.writes.map((write) => write.method).filter((method) => method === "createRepository")).toHaveLength(1);
    expect(github.repository("acme", "fixture")?.description).toBe(intent.marker);
  });

  it("refuses a branch someone else pushed while this operation's push was pending, and writes nothing", async () => {
    const { workDir, github } = makeSandbox();
    github.failNext = "pushBranch";
    expect((await produce(workDir, github)).allowed).toBe(false);
    const remote = github.repository("acme", "fixture");
    if (!remote) throw new Error("no repository");
    const other = mkdtempSync(join(tmpdir(), "acp-246-other-"));
    sandboxes.push(other);
    await git(other, ["init", "-q", "-b", "main"]);
    writeFileSync(join(other, "theirs.txt"), "someone else\n");
    await git(other, ["add", "theirs.txt"]);
    await git(other, ["-c", "user.email=x@example.com", "-c", "user.name=x", "commit", "-q", "-m", "theirs"]);
    await git(other, ["push", "-q", remote.bare, "HEAD:refs/heads/main"]);
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(evidenceOf(retry).refusal).toBe("UNRECEIPTED_RESOURCE");
    expect(github.writes).toEqual([]);
  });

  it("refuses a branch answer that describes another branch than the one asked about", async () => {
    const { workDir, github } = makeSandbox();
    const observe = github.observeBranch.bind(github);
    github.observeBranch = async (target, branch) => {
      const observed = await observe(target, branch);
      return observed === null ? null : { ...observed, name: "release" };
    };
    const produced = await produce(workDir, github);
    expect(produced.allowed).toBe(false);
    expect(evidenceOf(produced).refusal).toBe("REREAD_MISMATCH");
    expect(evidenceOf(produced).failedOperationId).toBe("push-default-branch:fixture");
  });

  it("says plainly when the leftover checkout is this operation's own and its ledger is not settled, and removes nothing", async () => {
    const { workDir, github } = makeSandbox();
    const first = await produce(workDir, github);
    if (!first.allowed) throw new Error(`${first.reasonCode}: ${first.message}`);
    // As a run that stopped before its last receipt would leave it.
    const ledger = readLedger(workDir);
    ledger.receipts = ledger.receipts.filter((receipt) => receipt.resourceType !== "branch-protection");
    writeFileSync(ledgerPath(workDir), JSON.stringify(ledger));
    const checkout = repositoryCheckoutPath(workDir, "primary");
    github.writes.length = 0;
    const again = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(again.allowed).toBe(false);
    expect(evidenceOf(again).refusal).toBe("INTERRUPTED_RUN_CHECKOUT");
    expect(existsSync(checkout)).toBe(true);
    expect(github.writes).toEqual([]);
  });
});

/**
 * PR #1043 review round 2 witnesses. Each reproduces its finding against the round-1 head
 * (88b286db), where it fails, and is kept as that finding's regression guard.
 */
describe("PR #1043 review round 2 witnesses", () => {
  it("RF1043-06: a replacement repository carrying the lost create's public marker is not adopted, and nothing is written to it", async () => {
    const { workDir, github } = makeSandbox();
    github.failAfter = { method: "createRepository", mode: "response" };
    expect((await produce(workDir, github)).allowed).toBe(false);
    const ours = github.repository("acme", "fixture");
    if (!ours) throw new Error("the create did not reach the double");
    // Deleted and recreated by someone else, who copied the public description.
    const replacement = await github.replace("acme", "fixture");
    replacement.description = ours.description;
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(evidenceOf(retry).refusal).toBe("WRONG_TARGET");
    expect(github.writes).toEqual([]);
  });

  it("RF1043-02: a result that could not be kept does not strand its checkout — the retry reconciles the ledger against GitHub and rebuilds it, with no write", async () => {
    // Round 2 kept the result in a file and its write failure stranded the checkout; round 3
    // removed the file (RF1043-08). The caller's store now runs inside the producer's cleanup.
    const { workDir, github } = makeSandbox();
    const attempt = (at: string, persist: (result: unknown) => void) =>
      produceRepoFactoryResult({
        plan: githubPlan(),
        workDir,
        clock: new ManualClock(at),
        github: { port: github, authority: authority() },
        persist,
      } as Parameters<typeof produceRepoFactoryResult>[0]);
    await expect(
      attempt("2026-10-02T00:00:00.000Z", () => {
        throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
      }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(readLedger(workDir).receipts).toHaveLength(4);
    expect(existsSync(repositoryCheckoutPath(workDir, "primary"))).toBe(false);
    github.writes.length = 0;
    github.reads.length = 0;
    let kept: unknown = null;
    const retry = await attempt("2026-10-02T00:05:00.000Z", (result) => {
      kept = result;
    });
    if (!retry.allowed) throw new Error(`${retry.reasonCode}: ${retry.message} ${JSON.stringify(retry.evidence)}`);
    expect(github.writes).toEqual([]);
    expect(github.reads.length).toBeGreaterThan(0);
    expect(kept).toEqual(retry.value);
  });

  it("a leftover checkout moved off the head GitHub holds is not settled, so it is named and kept rather than rebuilt", async () => {
    const { workDir, github } = makeSandbox();
    const first = await produce(workDir, github);
    if (!first.allowed) throw new Error(`${first.reasonCode}: ${first.message}`);
    rmSync(join(workDir, "github-ledger", "primary.result.json"), { force: true });
    const checkout = repositoryCheckoutPath(workDir, "primary");
    await git(checkout, ["-c", "user.email=x@example.com", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "local only"]);
    github.writes.length = 0;
    const again = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(again.allowed).toBe(false);
    expect(evidenceOf(again).refusal).toBe("INTERRUPTED_RUN_CHECKOUT");
    expect(existsSync(checkout)).toBe(true);
    expect(github.writes).toEqual([]);
  });

  it("a run that died after its last receipt leaves a checkout that is refused by name and kept for a person, not reclaimed", async () => {
    // Round 2 rebuilt this from a "settled" checkout; round 3 (RF1043-07) showed a matching HEAD
    // does not make the checkout's other contents recoverable, so it is never reclaimed.
    const { workDir, github } = makeSandbox();
    const first = await produce(workDir, github);
    if (!first.allowed) throw new Error(`${first.reasonCode}: ${first.message}`);
    const checkout = repositoryCheckoutPath(workDir, "primary");
    github.writes.length = 0;
    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(evidenceOf(retry).refusal).toBe("INTERRUPTED_RUN_CHECKOUT");
    expect(existsSync(checkout)).toBe(true);
    expect(github.writes).toEqual([]);
  });
});

/**
 * PR #1043 review round 3 witnesses. Each reproduces its finding against the round-2 head
 * (c884196b), where it fails, and is kept as that finding's regression guard.
 */
describe("PR #1043 review round 3 witnesses — a leftover checkout is never reclaimed", () => {
  it("RF1043-07: tracked edits, untracked and ignored files in a leftover checkout survive a retry, which is refused by name", async () => {
    const { workDir, github } = makeSandbox();
    const first = await produce(workDir, github);
    if (!first.allowed) throw new Error(`${first.reasonCode}: ${first.message}`);
    // As a run that died before storing its result leaves it (the reviewed head kept a file here).
    rmSync(join(workDir, "github-ledger", "primary.result.json"), { force: true });
    const checkout = repositoryCheckoutPath(workDir, "primary");
    writeFileSync(join(checkout, ".repo-factory-bootstrap.json"), "{ \"edited\": true }\n");
    writeFileSync(join(checkout, "notes.txt"), "untracked work\n");
    writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored.log\n", { flag: "a" });
    writeFileSync(join(checkout, "ignored.log"), "ignored work\n");
    github.writes.length = 0;

    const retry = await produce(workDir, github, { at: "2026-10-02T00:05:00.000Z" });
    expect(retry.allowed).toBe(false);
    expect(evidenceOf(retry).refusal).toBe("INTERRUPTED_RUN_CHECKOUT");
    expect(readFileSync(join(checkout, ".repo-factory-bootstrap.json"), "utf8")).toBe("{ \"edited\": true }\n");
    expect(readFileSync(join(checkout, "notes.txt"), "utf8")).toBe("untracked work\n");
    expect(readFileSync(join(checkout, "ignored.log"), "utf8")).toBe("ignored work\n");
    expect(github.writes).toEqual([]);
  });
});
