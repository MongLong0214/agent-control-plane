import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import {
  REPO_FACTORY_GITHUB_WRITE_OPERATION,
  RepoFactoryBootstrapRunner,
  repoFactoryGitHubWriteParameters,
  type ProduceAndActivateInput,
} from "../../src/bootstrap/repo-factory-bootstrap-run.ts";
import { repositoryCheckoutPath } from "../../src/bootstrap/repo-factory-producer.ts";
import { git } from "../../src/git/git.ts";
import { cleanupTempDirs, gitSync } from "../helpers/fixtures.ts";
import { TEST_OWNER, bindCeo, fixtureManifest, makeHarness, type Harness } from "../helpers/harness.ts";
import { FakeGitHub } from "../helpers/fake-github-write-port.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

/**
 * Issue #246 — the PROJECT_BOOTSTRAP run path: an owner-approved plan's GitHub writes are
 * performed, and the produced `repo-factory.result.v2` — not a hand-written fixture — is what
 * `BootstrapActivation.activate` receives.
 *
 * Everything below is the production code except two things: the model runtime (scripted, as in
 * every harness test) and GitHub, which is the bare-repository double in
 * `tests/helpers/fake-github-write-port.ts`. Every refusal asserts the double logged no write and
 * no read: a refusal that happened after a GitHub call is the defect this path exists to avoid.
 */

afterAll(cleanupTempDirs);

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CONTRACT = {
  goal: "bootstrap",
  why: "bootstrap",
  scope: [],
  nonGoals: [],
  acceptance: ["verify"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const HANDOFF: HandoffPackage = {
  projectStatus: "new",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "verify",
};

const IDENTITY = "github:acme/fixture";

const operations = () => [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository" as const,
    resourceIdentity: IDENTITY,
    desiredState: { visibility: "public" as const },
  },
  { operationId: "push-default-branch:fixture", resourceType: "branch" as const, resourceIdentity: `${IDENTITY}#main` },
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
    desiredState: {
      requiredStatusChecks: ["project-ci"],
      enforceAdmins: true,
      requiredApprovingReviewCount: null,
      allowForcePushes: false,
      allowDeletions: false,
    },
  },
];

const triples = (ops: ReturnType<typeof operations>) =>
  ops.map(({ operationId, resourceType, resourceIdentity }) => ({ operationId, resourceType, resourceIdentity }));

/** The blind-reviewed candidate a bootstrap run reaches CEO review with (as in ops-r2). */
const recordBootstrapBlindReview = (harness: Harness, runId: string): string => {
  const run = harness.cp.runs.require(runId);
  const head = gitSync(harness.repoPath, ["rev-parse", "HEAD"]);
  const snapshot: CandidateSnapshot = {
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId,
    contractDigest: run.contractDigest,
    repositories: [{
      identity: IDENTITY,
      repositoryRole: "primary",
      baseBranch: "main",
      baseHead: head,
      candidateHead: head,
      treeDigest: `git-tree:${gitSync(harness.repoPath, ["rev-parse", "HEAD^{tree}"])}`,
      diffDigest: digestOf({ bootstrapCandidate: runId }),
      worktreeId: null,
      manifestDigest: null,
      touchedPaths: [],
    }],
    createdAt: harness.clock.nowIso(),
  };
  const snapshotDigest = candidateSnapshotDigest(snapshot);
  harness.cp.artifacts.put(runId, "CANDIDATE_SNAPSHOT", snapshot, snapshotDigest);
  const reviewer = harness.cp.sessions.create({ provider: "scripted", model: "bootstrap-reviewer" });
  harness.cp.sessions.transition(reviewer.sessionId, SessionLifecycle.READY, "test reviewer");
  const reviewerBinding = harness.cp.bindings.bind({
    role: Role.BLIND_REVIEWER,
    roleKey: roleKeyFor(Role.BLIND_REVIEWER, { runId }),
    runId,
    sessionId: reviewer.sessionId,
  });
  if (!reviewerBinding.allowed) throw new Error(reviewerBinding.message);
  harness.cp.artifacts.putEvidence(harness.cp.evidenceWritersForTests().BLIND_REVIEW, runId, "BLIND_REVIEW", {
    runId,
    candidateSnapshotDigest: snapshotDigest,
    contractDigest: run.contractDigest,
    reviewerRoleBindingGeneration: reviewerBinding.value.bindingGeneration,
    reviewerSessionId: reviewer.sessionId,
    reviewerSessionIncarnation: reviewer.incarnation,
    reviewerProviderSessionId: reviewer.sessionId,
    provider: reviewer.provider,
    model: reviewer.model,
    effort: reviewer.effort,
    egressEvidence: testReviewerEgressEvidence(reviewer.provider),
    inputManifest: {
      contract: true,
      snapshotManifest: true,
      diff: true,
      verificationEvidence: true,
      projectContext: true,
      withheld: [],
      binaryArtifacts: [],
    },
    coveredRepositories: [IDENTITY],
    coveredFiles: [],
    omittedItems: [],
    verdict: "PASS",
    findings: [],
    chunked: false,
    createdAt: harness.clock.nowIso(),
  }, snapshotDigest);
  return snapshotDigest;
};

interface Prepared {
  harness: Harness;
  runId: string;
  github: FakeGitHub;
  runner: RepoFactoryBootstrapRunner;
  workRoot: string;
  planDigest: string;
  snapshotDigest: string;
  input: ProduceAndActivateInput;
}

/** A PROJECT_BOOTSTRAP run at CEO review with an approved PLAN, and a runner wired to a double. */
const prepare = async (projectId: string): Promise<Prepared> => {
  const harness = makeHarness();
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const bootstrapCto = harness.cp.sessions.create({ provider: "scripted", model: "bootstrap" });
  harness.cp.sessions.transition(bootstrapCto.sessionId, SessionLifecycle.READY, "test");
  const bound = harness.cp.bootstrap.bindBootstrapCto(runId, bootstrapCto.sessionId);
  if (!bound.allowed) throw new Error(bound.message);
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const snapshotDigest = recordBootstrapBlindReview(harness, runId);
  harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "reviewed");

  const manifest = fixtureManifest(projectId);
  const approvedPlan = {
    bootstrapOperationId: "op-bootstrap",
    requestDigest: digestOf({ request: "bootstrap" }),
    projectManifestDigest: manifestDigest(manifest),
    githubOperations: triples(operations()),
  };
  const planArtifact = harness.cp.artifacts.put(runId, "PLAN", approvedPlan);

  const workRoot = mkdtempSync(join(tmpdir(), "acp-246-run-"));
  roots.push(workRoot);
  const github = new FakeGitHub(workRoot);
  const runner = new RepoFactoryBootstrapRunner({
    runs: harness.cp.runs,
    artifacts: harness.cp.artifacts,
    ownerAuthority: harness.cp.ownerAuthority,
    bootstrap: harness.cp.bootstrap,
    githubPort: github,
    workRoot,
    clock: harness.cp.clock,
  });
  const input: ProduceAndActivateInput = {
    runId,
    plan: {
      runId,
      bootstrapOperationId: approvedPlan.bootstrapOperationId,
      requestDigest: approvedPlan.requestDigest,
      planDigest: planArtifact.digest,
      projectManifestDigest: approvedPlan.projectManifestDigest,
      repositoryRole: "primary",
      defaultBranch: "main",
      verificationCommandId: "verify",
      verificationKind: "CLEAN_TREE",
      githubOperations: operations(),
    },
    ownerApproval: null,
    approvedManifest: manifest,
    projectName: projectId,
    handoff: HANDOFF,
  };
  return { harness, runId, github, runner, workRoot, planDigest: planArtifact.digest, snapshotDigest, input };
};

/**
 * The owner's approval as production would carry it: admitted through the real ingress guard,
 * for this run's current candidate, over exactly the parameters named.
 */
const ownerApproval = (
  prepared: Prepared,
  overrides: { visibility?: "public" | "private"; approved?: boolean; operations?: ReturnType<typeof triples> } = {},
): NonNullable<ProduceAndActivateInput["ownerApproval"]> => {
  const { harness, runId } = prepared;
  const parameters = repoFactoryGitHubWriteParameters({
    owner: "acme",
    visibility: overrides.visibility ?? "public",
    planDigest: prepared.planDigest,
    githubOperations: overrides.operations ?? triples(operations()),
  });
  const approved = overrides.approved ?? true;
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    cli: { allowedActors: [TEST_OWNER.actor] },
  });
  const approval = {
    runId,
    candidateSnapshotDigest: harness.cp.runs.currentCandidate(runId),
    operation: REPO_FACTORY_GITHUB_WRITE_OPERATION,
    parameters,
    idempotencyKey: `repo-factory-write:${digestOf({ runId, parameters, approved })}`,
    approved,
  };
  const admitted = guard.admitOwnerApproval(
    { channel: "cli", actor: TEST_OWNER.actor, nonce: `rf-write:${digestOf(approval)}`, payload: ownerApprovalPayload(approval) },
    approval,
  );
  if (!admitted.allowed) throw new Error(`${admitted.reasonCode}: ${admitted.message}`);
  return { owner: "acme", visibility: "public", receipt: admitted.value };
};

const noGitHubCall = (prepared: Prepared): void => {
  expect(prepared.github.writes).toEqual([]);
  expect(prepared.github.reads).toEqual([]);
  expect(existsSync(repositoryCheckoutPath(join(prepared.workRoot, prepared.runId), "primary"))).toBe(false);
  expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();
};

describe("PROJECT_BOOTSTRAP run path: produce, then activate (#246)", () => {
  it("activates the result the producer wrote to GitHub, and a second call activates it again rather than producing again", async () => {
    const prepared = await prepare("produced-activation");
    const { harness, runId, github } = prepared;
    const input = { ...prepared.input, ownerApproval: ownerApproval(prepared) };

    const first = await prepared.runner.produceAndActivate(input);
    // A fresh bootstrap stops once: the incoming primary CTO has not acknowledged its handoff.
    if (first.allowed) throw new Error("the handoff must still be pending");
    expect(first.reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
    expect(first.evidence["stage"]).toBe("activation");
    expect(github.writes.map((write) => write.method)).toEqual([
      "createRepository",
      "pushBranch",
      "setDefaultBranch",
      "protectBranch",
    ]);
    const retained = harness.cp.artifacts.latest<{ repositories: Array<{ identity: string }> }>(runId, "REPO_FACTORY_RESULT");
    expect(retained?.content.repositories.map((repository) => repository.identity)).toEqual([IDENTITY]);

    const primary = harness.cp.bindings.activePrimaryCto("produced-activation");
    if (!primary) throw new Error("activation bound no primary CTO");
    const handoffId = first.evidence["pendingHandoffId"] as string;
    expect(harness.cp.bootstrap.acknowledgeActivationHandoff(handoffId, primary.sessionId).allowed).toBe(true);

    github.writes.length = 0;
    const second = await prepared.runner.produceAndActivate(input);
    if (!second.allowed) throw new Error(`${second.reasonCode}: ${second.message} ${JSON.stringify(second.evidence)}`);
    expect(github.writes).toEqual([]);

    // The bound checkout is the one the producer made, at the head GitHub holds.
    const checkout = repositoryCheckoutPath(join(prepared.workRoot, runId), "primary");
    expect(second.value.localBindings).toEqual([
      expect.objectContaining({ identity: IDENTITY, repositoryRole: "primary" }),
    ]);
    const remote = github.repository("acme", "fixture");
    if (!remote) throw new Error("the double holds no repository");
    const remoteHead = (await git(remote.bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
    expect((await git(checkout, ["rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
    expect(harness.cp.repositories.byIdentity(IDENTITY)).not.toBeNull();

    // And the CEO confirm completes the run on that activation.
    const ceoSessionId = bindCeo(harness);
    await harness.cp.continuity.evaluate("bootstrap confirmation");
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: prepared.snapshotDigest,
      ceoSessionId,
      rationale: "activation driven by produced output",
    });
    if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);
    expect(harness.cp.runs.require(runId).state).toBe(RunState.COMPLETED);
  });

  it("refuses with no owner approval, before any GitHub call", async () => {
    const prepared = await prepare("no-approval");
    const refused = await prepared.runner.produceAndActivate(prepared.input);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(refused.evidence["refusal"]).toBe("APPROVAL_MISSING");
    noGitHubCall(prepared);
  });

  it("refuses an approval the owner declined, before any GitHub call", async () => {
    const prepared = await prepare("declined");
    const refused = await prepared.runner.produceAndActivate({
      ...prepared.input,
      ownerApproval: ownerApproval(prepared, { approved: false }),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("APPROVAL_DECLINED");
    noGitHubCall(prepared);
  });

  it("refuses a receipt the caller assembled itself — the ingress admission is what makes it authority", async () => {
    const prepared = await prepare("forged");
    const genuine = ownerApproval(prepared);
    const forged = {
      ...genuine,
      receipt: { ...(genuine.receipt as Record<string, unknown>), inboundNonce: "never-admitted" },
    };
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: forged });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(refused.evidence["stage"]).toBe("approval");
    noGitHubCall(prepared);
  });

  describe("the plan and the approval must agree", () => {
    it("refuses an approval the owner gave for a different visibility", async () => {
      const prepared = await prepare("approved-private");
      const refused = await prepared.runner.produceAndActivate({
        ...prepared.input,
        ownerApproval: ownerApproval(prepared, { visibility: "private" }),
      });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("APPROVAL_MISMATCH");
      noGitHubCall(prepared);
    });

    it("refuses an approval the owner gave for a different set of operations", async () => {
      const prepared = await prepare("approved-fewer");
      const refused = await prepared.runner.produceAndActivate({
        ...prepared.input,
        ownerApproval: ownerApproval(prepared, { operations: triples(operations()).slice(0, 2) }),
      });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("APPROVAL_MISMATCH");
      noGitHubCall(prepared);
    });

    it("refuses an executable plan carrying an operation the approved PLAN artifact does not, and leaves the approval unconsumed", async () => {
      const prepared = await prepare("plan-adds-operation");
      const approval = ownerApproval(prepared);
      const plan = prepared.input.plan as { githubOperations: unknown[] };
      const refused = await prepared.runner.produceAndActivate({
        ...prepared.input,
        plan: {
          ...plan,
          githubOperations: [
            ...plan.githubOperations,
            {
              operationId: "protect-release-branch:fixture",
              resourceType: "branch-protection",
              resourceIdentity: `${IDENTITY}#release`,
              desiredState: operations()[3]!.desiredState,
            },
          ],
        },
        ownerApproval: approval,
      });
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
      expect(refused.evidence["refusal"]).toBe("OPERATION_NOT_IN_PLAN");
      noGitHubCall(prepared);
      const candidate = prepared.harness.cp.runs.currentCandidate(prepared.runId) ?? "";
      expect(
        prepared.harness.cp.ownerAuthority.assertConsumedApproval(
          approval.receipt as Parameters<typeof prepared.harness.cp.ownerAuthority.assertConsumedApproval>[0],
          candidate,
        ).allowed,
      ).toBe(false);
    });

    it("refuses an executable plan whose plan digest is not the approved PLAN artifact's", async () => {
      const prepared = await prepare("plan-digest");
      const refused = await prepared.runner.produceAndActivate({
        ...prepared.input,
        plan: { ...(prepared.input.plan as object), planDigest: "sha256:" + "f".repeat(64) },
        ownerApproval: ownerApproval(prepared),
      });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("PLAN_MISMATCH");
      expect(refused.evidence["field"]).toBe("planDigest");
      noGitHubCall(prepared);
    });

    it("refuses a manifest whose remote is not the repository the plan creates", async () => {
      const prepared = await prepare("manifest-remote");
      const manifest = fixtureManifest("manifest-remote", {
        repositories: [{ role: "primary", remote: "github:acme/other", manifestRoot: "." }],
      });
      // The PLAN artifact approved this manifest, so only the remote disagrees.
      prepared.harness.cp.artifacts.put(prepared.runId, "PLAN", {
        bootstrapOperationId: "op-bootstrap",
        requestDigest: digestOf({ request: "bootstrap" }),
        projectManifestDigest: manifestDigest(manifest),
        githubOperations: triples(operations()),
      });
      const planDigest = prepared.harness.cp.artifacts.latest(prepared.runId, "PLAN")?.digest ?? "";
      const refused = await prepared.runner.produceAndActivate({
        ...prepared.input,
        plan: {
          ...(prepared.input.plan as object),
          planDigest,
          projectManifestDigest: manifestDigest(manifest),
        },
        approvedManifest: manifest,
        ownerApproval: ownerApproval({ ...prepared, planDigest }),
      });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("MANIFEST_MISMATCH");
      noGitHubCall(prepared);
    });
  });

  it("a partial failure resumes on the same approval, writing only what was left", async () => {
    const prepared = await prepare("partial-resume");
    const input = { ...prepared.input, ownerApproval: ownerApproval(prepared) };
    prepared.github.failNext = "protectBranch";
    const first = await prepared.runner.produceAndActivate(input);
    expect(first.allowed).toBe(false);
    expect(first.evidence["stage"]).toBe("production");
    expect(first.evidence["refusal"]).toBe("REMOTE_REFUSED");
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();

    prepared.github.writes.length = 0;
    const second = await prepared.runner.produceAndActivate(input);
    expect(second.evidence["stage"]).toBe("activation");
    expect(prepared.github.writes.map((write) => write.method)).toEqual(["protectBranch"]);
  });

  it("the control plane composes the runner with the production port, and an unconfigured work root refuses before it", async () => {
    const prepared = await prepare("unconfigured");
    expect(prepared.harness.cp.bootstrapProducer).toBeInstanceOf(RepoFactoryBootstrapRunner);
    const refused = await prepared.harness.cp.bootstrapProducer.produceAndActivate({
      ...prepared.input,
      ownerApproval: ownerApproval(prepared),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("WORK_ROOT_UNCONFIGURED");
    // This runner holds the production `gh` port, which no double counts; the refusal sits ahead
    // of the approval's consumption and of every port call in `produceAndActivate`.
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();
  });

  it("refuses a bootstrap activation would refuse anyway — here an incomplete handoff — before any GitHub call", async () => {
    const prepared = await prepare("incomplete-handoff");
    const refused = await prepared.runner.produceAndActivate({
      ...prepared.input,
      handoff: { ...HANDOFF, recommendedNextAction: "" },
      ownerApproval: ownerApproval(prepared),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.HANDOFF_PACKAGE_INCOMPLETE);
    expect(refused.evidence["stage"]).toBe("precondition");
    noGitHubCall(prepared);
  });

  it("refuses a run that has not reached CEO review, before any GitHub call", async () => {
    const prepared = await prepare("not-reviewed");
    prepared.harness.cp.runs.transition(prepared.runId, RunState.REVISION_REQUIRED, "sent back");
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: null });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
    expect(refused.evidence["stage"]).toBe("precondition");
    noGitHubCall(prepared);
  });
});
