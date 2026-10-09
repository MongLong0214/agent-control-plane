import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
import {
  TEST_OWNER,
  bindCeo,
  completeBootstrapRunUntilC3,
  dispatchBootstrapRun,
  fixtureManifest,
  makeHarness,
  type Harness,
} from "../helpers/harness.ts";
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
 *
 * The operations executed are the approved PLAN artifact's own, desired state included; no caller
 * supplies an executable plan (PR #1043 review, RF1043-01).
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

const APPROVED_PROTECTION = {
  requiredStatusChecks: { strict: true, contexts: ["project-ci"] },
  enforceAdmins: true,
  requiredApprovingReviewCount: 1,
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
    desiredState: APPROVED_PROTECTION,
  },
];

type Operation = ReturnType<typeof operations>[number];

/** The one verification this producer can honestly run, declared as a manifest command. */
const CLEAN_TREE_COMMAND = {
  id: "clean-tree",
  argv: ["git", "status", "--porcelain"],
  repositoryRole: "primary",
  cwd: ".",
  timeoutSeconds: 120,
  envAllowlist: [],
  network: "deny" as const,
  networkAllowlist: [],
  required: true as const,
  evidenceMode: "LOCAL_COMMAND" as const,
  maxOutputBytes: 1_048_576,
  maxMemoryMb: 2048,
};

const cleanTreeManifest = (projectId: string, overrides: Parameters<typeof fixtureManifest>[1] = {}) =>
  fixtureManifest(projectId, {
    verificationCommands: [CLEAN_TREE_COMMAND],
    verificationProfiles: { simple: ["clean-tree"], standard: ["clean-tree"], guarded: ["clean-tree"] },
    ...overrides,
  });

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
  ops: Operation[];
  planDigest: string;
  snapshotDigest: string;
  input: ProduceAndActivateInput;
}

type ArtifactsPort = ConstructorParameters<typeof RepoFactoryBootstrapRunner>[0]["artifacts"];

/** A PROJECT_BOOTSTRAP run at CEO review with an approved PLAN, and a runner wired to a double. */
const prepare = async (
  projectId: string,
  options: {
    ops?: Operation[];
    manifest?: ReturnType<typeof fixtureManifest>;
    artifacts?: (real: ArtifactsPort) => ArtifactsPort;
  } = {},
): Promise<Prepared> => {
  const harness = makeHarness();
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  // Dispatch staffs the run's BOOTSTRAP_CTO and pins it as the owner (#246).
  await dispatchBootstrapRun(harness.cp, harness.clock, runId);
  const snapshotDigest = recordBootstrapBlindReview(harness, runId);
  harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "reviewed");

  const manifest = options.manifest ?? cleanTreeManifest(projectId);
  const ops = options.ops ?? operations();
  const planArtifact = harness.cp.artifacts.put(runId, "PLAN", {
    bootstrapOperationId: "op-bootstrap",
    requestDigest: digestOf({ request: "bootstrap" }),
    projectManifestDigest: manifestDigest(manifest),
    githubOperations: ops,
  });

  const workRoot = mkdtempSync(join(tmpdir(), "acp-246-run-"));
  roots.push(workRoot);
  const github = new FakeGitHub(workRoot);
  const runner = new RepoFactoryBootstrapRunner({
    runs: harness.cp.runs,
    artifacts: options.artifacts ? options.artifacts(harness.cp.artifacts) : harness.cp.artifacts,
    ownerAuthority: harness.cp.ownerAuthority,
    bootstrap: harness.cp.bootstrap,
    githubPort: github,
    workRoot,
    clock: harness.cp.clock,
  });
  const input: ProduceAndActivateInput = {
    runId,
    // The candidate the CEO confirms: the one the blind review above passed.
    candidateSnapshotDigest: snapshotDigest,
    ownerApproval: null,
    approvedManifest: manifest,
    projectName: projectId,
    handoff: HANDOFF,
  };
  return { harness, runId, github, runner, workRoot, ops, planDigest: planArtifact.digest, snapshotDigest, input };
};

/**
 * The owner's approval as production would carry it: admitted through the real ingress guard,
 * for this run's current candidate, over exactly the parameters named.
 */
const ownerApproval = (
  prepared: Pick<Prepared, "harness" | "runId" | "planDigest" | "ops">,
  overrides: { visibility?: "public" | "private"; approved?: boolean; operations?: Operation[] } = {},
): NonNullable<ProduceAndActivateInput["ownerApproval"]> => {
  const { harness, runId } = prepared;
  const parameters = repoFactoryGitHubWriteParameters({
    owner: "acme",
    visibility: overrides.visibility ?? "public",
    planDigest: prepared.planDigest,
    githubOperations: overrides.operations ?? prepared.ops,
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

/**
 * The executable plan the reviewed head (afd93586) took from its caller, in that head's
 * protection vocabulary. The witnesses below pass it so each one reproduces its finding there;
 * the corrected runner has no such input and executes the PLAN artifact instead.
 */
const reviewedHeadPlan = (
  prepared: Prepared,
  overrides: { verificationCommandId?: string; protection?: Record<string, unknown> } = {},
) => ({
  runId: prepared.runId,
  bootstrapOperationId: "op-bootstrap",
  requestDigest: digestOf({ request: "bootstrap" }),
  planDigest: prepared.planDigest,
  projectManifestDigest: manifestDigest(prepared.input.approvedManifest),
  repositoryRole: "primary",
  defaultBranch: "main",
  verificationCommandId: overrides.verificationCommandId ?? "clean-tree",
  verificationKind: "CLEAN_TREE",
  githubOperations: prepared.ops.map((operation) =>
    operation.resourceType === "branch-protection"
      ? {
          ...operation,
          desiredState: overrides.protection ?? {
            ...APPROVED_PROTECTION,
            requiredStatusChecks: APPROVED_PROTECTION.requiredStatusChecks.contexts,
          },
        }
      : operation,
  ),
});

const withReviewedHeadPlan = (input: ProduceAndActivateInput, plan: object): ProduceAndActivateInput =>
  ({ ...input, plan }) as ProduceAndActivateInput;

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
    // The protection GitHub holds is the one the approved PLAN artifact names.
    expect(github.repository("acme", "fixture")?.protections.get("main")).toEqual(APPROVED_PROTECTION);
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

    // And the CEO confirm completes the run on that activation. Issue #246 PR-C: the bootstrap
    // CONFIRM is shut until C3, so the gate refuses it and nothing is completed by it.
    const ceoSessionId = bindCeo(harness);
    await harness.cp.continuity.evaluate("bootstrap confirmation");
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: prepared.snapshotDigest,
      ceoSessionId,
      rationale: "activation driven by produced output",
    });
    expect(confirmed.reasonCode).toBe(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE);
    // TODO(C3): confirm through `submitCeoDecision` again once C3 reopens the bootstrap CONFIRM.
    const completed = completeBootstrapRunUntilC3(harness.cp, {
      runId,
      candidateSnapshotDigest: prepared.snapshotDigest,
      ceoSessionId,
    });
    if (!completed.allowed) throw new Error(`${completed.reasonCode}: ${completed.message}`);
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

    it("refuses an approval the owner gave for different operation parameters", async () => {
      const prepared = await prepare("approved-weaker");
      const weaker = prepared.ops.map((operation) =>
        operation.resourceType === "branch-protection"
          ? { ...operation, desiredState: { ...APPROVED_PROTECTION, allowForcePushes: true } }
          : operation,
      );
      const refused = await prepared.runner.produceAndActivate({
        ...prepared.input,
        ownerApproval: ownerApproval(prepared, { operations: weaker }),
      });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("APPROVAL_MISMATCH");
      noGitHubCall(prepared);
    });

    it("refuses when the PLAN artifact was replaced after the owner approved it — the approval names the digest it saw", async () => {
      const prepared = await prepare("plan-replaced");
      const approval = ownerApproval(prepared);
      prepared.harness.cp.artifacts.put(prepared.runId, "PLAN", {
        bootstrapOperationId: "op-bootstrap",
        requestDigest: digestOf({ request: "bootstrap" }),
        projectManifestDigest: manifestDigest(prepared.input.approvedManifest),
        githubOperations: prepared.ops.map((operation) =>
          operation.resourceType === "branch-protection"
            ? { ...operation, desiredState: { ...APPROVED_PROTECTION, allowForcePushes: true, allowDeletions: true } }
            : operation,
        ),
      });
      const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: approval });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("APPROVAL_MISMATCH");
      noGitHubCall(prepared);
    });

    it("refuses a PLAN artifact whose operations carry no desired state — there is nothing approved to execute", async () => {
      const prepared = await prepare("plan-triples-only", {
        ops: operations().map(({ operationId, resourceType, resourceIdentity }) => ({
          operationId,
          resourceType,
          resourceIdentity,
        })) as unknown as Operation[],
      });
      const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApproval(prepared) });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("PLAN_NOT_EXECUTABLE");
      noGitHubCall(prepared);
    });

    it("refuses a manifest that wants its one command as CI evidence, which a local run cannot be", async () => {
      const manifest = cleanTreeManifest("trusted-ci", {
        verificationCommands: [{ ...CLEAN_TREE_COMMAND, evidenceMode: "TRUSTED_CI" as const }],
      });
      const prepared = await prepare("trusted-ci", { manifest });
      const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApproval(prepared) });
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("UNSUPPORTED_VERIFICATION");
      expect(refused.evidence["evidenceMode"]).toBe("TRUSTED_CI");
      noGitHubCall(prepared);
    });

    it("refuses a manifest whose remote is not the repository the plan creates", async () => {
      const manifest = cleanTreeManifest("manifest-remote", {
        repositories: [{ role: "primary", remote: "github:acme/other", manifestRoot: "." }],
      });
      const prepared = await prepare("manifest-remote", { manifest });
      const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApproval(prepared) });
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

/**
 * PR #1043 review witnesses. Each reproduces its finding against the reviewed head (afd93586),
 * where it fails, and is kept as that finding's regression guard.
 */
describe("PR #1043 review witnesses — the run path", () => {
  it("RF1043-01: executes the protection the approved PLAN artifact holds, never a weaker one a caller supplies under the same digest", async () => {
    const prepared = await prepare("rf1043-01");
    const weakened = reviewedHeadPlan(prepared, {
      protection: {
        requiredStatusChecks: [],
        enforceAdmins: false,
        requiredApprovingReviewCount: null,
        allowForcePushes: true,
        allowDeletions: true,
      },
    });
    await prepared.runner.produceAndActivate(
      withReviewedHeadPlan({ ...prepared.input, ownerApproval: ownerApproval(prepared) }, weakened),
    );
    expect(prepared.github.repository("acme", "fixture")?.protections.get("main")).toEqual(APPROVED_PROTECTION);
  });

  it("RF1043-03: refuses, before any GitHub call, a manifest command this producer would not run (`node verify.js`)", async () => {
    const prepared = await prepare("rf1043-03-command", { manifest: fixtureManifest("rf1043-03-command") });
    const refused = await prepared.runner.produceAndActivate(
      withReviewedHeadPlan(
        { ...prepared.input, ownerApproval: ownerApproval(prepared) },
        reviewedHeadPlan(prepared, { verificationCommandId: "verify" }),
      ),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("UNSUPPORTED_VERIFICATION");
    noGitHubCall(prepared);
  });

  it("RF1043-03: refuses, before any GitHub call, a manifest requiring CI evidence this producer never produces", async () => {
    const manifest = cleanTreeManifest("rf1043-03-ci", {
      ciWorkflows: [{
        path: ".github/workflows/ci.yml",
        checkName: "project-ci",
        repositoryRole: "primary",
        approvedDigest: null,
        unapprovedFirstActivation: true,
      }],
    });
    const prepared = await prepare("rf1043-03-ci", { manifest });
    const refused = await prepared.runner.produceAndActivate(
      withReviewedHeadPlan({ ...prepared.input, ownerApproval: ownerApproval(prepared) }, reviewedHeadPlan(prepared)),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("UNSUPPORTED_VERIFICATION");
    noGitHubCall(prepared);
  });

  it("RF1043-02: a result produced but not stored is reconstructed on retry, not refused at its own checkout", async () => {
    let failOnce = true;
    const prepared = await prepare("rf1043-02-result", {
      artifacts: (real) => ({
        latest: (...args: Parameters<ArtifactsPort["latest"]>) => real.latest(...args),
        put: (...args: Parameters<ArtifactsPort["put"]>) => {
          if (args[1] === "REPO_FACTORY_RESULT" && failOnce) {
            failOnce = false;
            throw new Error("database is locked");
          }
          return real.put(...args);
        },
      }) as ArtifactsPort,
    });
    const input = withReviewedHeadPlan({ ...prepared.input, ownerApproval: ownerApproval(prepared) }, reviewedHeadPlan(prepared));
    await expect(prepared.runner.produceAndActivate(input)).rejects.toThrow(/database is locked/);

    prepared.github.writes.length = 0;
    prepared.github.reads.length = 0;
    const retry = await prepared.runner.produceAndActivate(input);
    expect(retry.evidence["stage"]).toBe("activation");
    // The ordinary path: the ledger reconciled against GitHub (reads), nothing written again.
    expect(prepared.github.reads.length).toBeGreaterThan(0);
    expect(prepared.github.writes).toEqual([]);
  });
});

/**
 * PR #1043 review round 3 witness (RF1043-08). Reproduced against the round-2 head (c884196b),
 * where it fails, and kept as the regression guard.
 */
describe("PR #1043 review round 3 witnesses — the run path", () => {
  it("RF1043-08: a result file nobody produced, with a declined approval no ingress admitted, reaches neither activation nor GitHub", async () => {
    const prepared = await prepare("rf1043-08");
    const activate = vi.spyOn(prepared.harness.cp.bootstrap, "activate");
    const workDir = join(prepared.workRoot, prepared.runId);
    // A real checkout for the forged result to name, so only provenance could tell it apart.
    const checkout = join(workDir, "repositories", "primary");
    mkdirSync(checkout, { recursive: true, mode: 0o700 });
    await git(checkout, ["init", "-q", "-b", "main"]);
    writeFileSync(join(checkout, "README.md"), "invented\n");
    await git(checkout, ["add", "README.md"]);
    await git(checkout, ["-c", "user.email=x@example.com", "-c", "user.name=x", "commit", "-q", "-m", "invented"]);
    const head = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
    const requestDigest = digestOf({ request: "bootstrap" });
    const forged = {
      schema: "repo-factory.result.v2",
      runId: prepared.runId,
      bootstrapOperationId: "op-bootstrap",
      planDigest: prepared.planDigest,
      projectManifestDigest: manifestDigest(prepared.input.approvedManifest),
      repositories: [{ role: "primary", identity: IDENTITY, proposedCheckoutPath: checkout, defaultBranch: "main", createdBranches: [] }],
      externalWriteReceipts: prepared.ops.map(({ operationId, resourceType, resourceIdentity }) => ({
        bootstrapOperationId: "op-bootstrap",
        requestDigest,
        operationId,
        resourceType,
        resourceIdentity,
        preexisting: false,
        beforeStateDigest: null,
        afterStateDigest: digestOf({ invented: operationId }),
        createdAt: "2026-10-02T00:00:00.000Z",
        rereadAt: "2026-10-02T00:00:01.000Z",
        verified: true,
      })),
      bootstrapVerification: [{ commandId: "clean-tree", repositoryIdentity: IDENTITY, exactHead: head, status: "PASS" }],
      ciEvidence: [],
      unresolvedGaps: [],
    };
    mkdirSync(join(workDir, "github-ledger"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(workDir, "github-ledger", "primary.result.json"),
      JSON.stringify({ schema: "acp.repo-factory.produced-result.v1", bootstrapOperationId: "op-bootstrap", requestDigest, result: forged }),
      { mode: 0o600 },
    );
    const declined = ownerApproval(prepared, { approved: false });
    const unadmitted = { ...declined, receipt: { ...(declined.receipt as Record<string, unknown>), inboundNonce: "never-admitted" } };

    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: unadmitted });
    expect(refused.allowed).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();
    expect(prepared.github.writes).toEqual([]);
    expect(prepared.github.reads).toEqual([]);
  });
});
