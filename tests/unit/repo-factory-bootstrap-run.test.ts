import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, RunKind, RunState } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { plannedBootstrapOutputs } from "../../src/bootstrap/bootstrap-plan.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import {
  REPO_FACTORY_GITHUB_WRITE_OPERATION,
  RepoFactoryBootstrapRunner,
  attemptCheckoutPath,
  repoFactoryGitHubWriteParameters,
  type ProduceAndActivateInput,
} from "../../src/bootstrap/repo-factory-bootstrap-run.ts";
import { git } from "../../src/git/git.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  dispatchBootstrapRun,
  fixtureManifest,
  makeHarness,
  type Harness,
} from "../helpers/harness.ts";
import { bootstrapPlan, replanBootstrap, reviewBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { FakeGitHub } from "../helpers/fake-github-write-port.ts";

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

interface Prepared {
  harness: Harness;
  runId: string;
  github: FakeGitHub;
  runner: RepoFactoryBootstrapRunner;
  workRoot: string;
  ops: Operation[];
  planDigest: string;
  snapshotDigest: string;
  ceoSessionId: string;
  manifest: ReturnType<typeof fixtureManifest>;
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

  // #246 C2 — the bootstrap CTO's PLAN (its manifest included) is reviewed to CEO review through
  // `result_submit`'s BOOTSTRAP_PLAN review. A PLAN the producer could not execute has no planned
  // outputs and so no review; for those rows an executable PLAN is reviewed, and the PLAN under test
  // replaces it afterwards, as these rows always put it: after the review.
  const manifest = options.manifest ?? cleanTreeManifest(projectId);
  const ops = options.ops ?? operations();
  const plan = bootstrapPlan(manifest, { operations: ops });
  const plannable = plannedBootstrapOutputs({ runId, planArtifact: { digest: "probe", content: plan } }, manifest).allowed;
  const reviewed = await reviewBootstrapPlan(harness, runId, plannable ? plan : bootstrapPlan(cleanTreeManifest(projectId)));
  const snapshotDigest = reviewed.snapshotDigest;
  const planArtifact = plannable ? { digest: reviewed.planDigest } : harness.cp.artifacts.put(runId, "PLAN", plan);

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
    // #246 C3 — the application record and the pre-write checks' sources, as composed.
    db: harness.cp.db,
    applications: harness.cp.bootstrapApplications,
    ceo: harness.cp.ceo,
    bindings: harness.cp.bindings,
    projects: harness.cp.projects,
    repositories: harness.cp.repositories,
  });
  // #246 C3 — no daemon runs here: the test process is the only control-plane writer, and every
  // attempt runs in it, which a daemon's single-instance lock and its holder record attest in
  // production. A new attempt after an earlier one asks both.
  const thisProcess = { pid: process.pid, startToken: readProcessStartToken(process.pid), startedAt: new Date().toISOString() };
  runner.attachWriterLock(() => true, () => thisProcess);
  // The CEO decision completes a bootstrap on the chain this runner verifies, as composed (#246 C3).
  harness.cp.ceo.attach({ bootstrapCompletionChain: runner });
  // The CEO's admission, which the runner asks among its pre-write checks, needs a current
  // continuity evaluation, as the CONFIRM door has before it calls the runner.
  await harness.cp.continuity.evaluate("bootstrap confirmation");
  const input: ProduceAndActivateInput = {
    runId,
    // The candidate the CEO confirms: the one the blind review above passed.
    candidateSnapshotDigest: snapshotDigest,
    ceoSessionId: reviewed.ceoSessionId,
    ownerApproval: null,
    approvedManifest: manifest,
    projectName: projectId,
    handoff: HANDOFF,
  };
  return {
    harness,
    runId,
    github,
    runner,
    workRoot,
    ops,
    planDigest: planArtifact.digest,
    snapshotDigest,
    ceoSessionId: reviewed.ceoSessionId,
    manifest,
    input,
  };
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
  expect(existsSync(attemptCheckoutPath(join(prepared.workRoot, prepared.runId), "primary", 1))).toBe(false);
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
    const checkout = attemptCheckoutPath(join(prepared.workRoot, runId), "primary", 1);
    expect(second.value.localBindings).toEqual([
      expect.objectContaining({ identity: IDENTITY, repositoryRole: "primary" }),
    ]);
    const remote = github.repository("acme", "fixture");
    if (!remote) throw new Error("the double holds no repository");
    const remoteHead = (await git(remote.bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
    expect((await git(checkout, ["rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
    expect(harness.cp.repositories.byIdentity(IDENTITY)).not.toBeNull();

    // And the CEO confirm completes the run on that activation, and its WRITTEN application with it
    // (#246 C3): one attempt, one reservation, COMPLETED in the same transaction as the run.
    expect(harness.cp.bootstrapApplications.get(runId)).toMatchObject({ phase: "WRITTEN", attempts: 1 });
    const ceoSessionId = prepared.ceoSessionId;
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
    expect(harness.cp.bootstrapApplications.get(runId)).toMatchObject({ phase: "COMPLETED", attempts: 1 });
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
      // #246 C2 — the replacement is a re-plan the CTO submits and the reviewer passes, so the
      // review of the confirmed candidate is current and only the approval can tell them apart.
      const replanned = await replanBootstrap(
        prepared.harness,
        prepared.runId,
        { planDigest: prepared.planDigest, snapshotDigest: prepared.snapshotDigest, ceoSessionId: prepared.ceoSessionId },
        bootstrapPlan(prepared.manifest, {
          operations: prepared.ops.map((operation) =>
            operation.resourceType === "branch-protection"
              ? { ...operation, desiredState: { ...APPROVED_PROTECTION, allowForcePushes: true, allowDeletions: true } }
              : operation,
          ),
        }),
      );
      const refused = await prepared.runner.produceAndActivate({
        ...prepared.input,
        candidateSnapshotDigest: replanned.snapshotDigest,
        ownerApproval: approval,
      });
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
    // GitHub fails the read that precedes the protection request, so that request is never sent
    // (#246 C3, review 1076-R1-03: a request sent and never answered is not sent again).
    vi.spyOn(prepared.github, "observeBranchProtection").mockRejectedValueOnce(new Error("HTTP 502 injected on observeBranchProtection"));
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

  it("a request that failed without proof is never sent again: IN_DOUBT until GitHub shows its effect, then adopted with no write (#246 C3, review 1076-R1-03)", async () => {
    const prepared = await prepare("pending-protection");
    const input = { ...prepared.input, ownerApproval: ownerApproval(prepared) };
    const protect = prepared.github.protectBranch.bind(prepared.github);
    let held: (() => Promise<void>) | null = null;
    vi.spyOn(prepared.github, "protectBranch").mockImplementationOnce(async (target, branch, desired) => {
      held = () => protect(target, branch, desired);
      throw new Error("client timeout; the server still holds the request");
    });
    const first = await prepared.runner.produceAndActivate(input);
    expect(first.evidence["refusal"]).toBe("REMOTE_REFUSED");

    prepared.github.writes.length = 0;
    const second = await prepared.runner.produceAndActivate(input);
    expect(second).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
      evidence: { refusal: "UNCONFIRMED_PENDING_REQUEST", unsettled: [expect.objectContaining({ resourceType: "branch-protection" })] },
    });
    expect(prepared.github.writes).toEqual([]);

    // The held request lands: GitHub shows the approved protection, and the resume adopts it.
    if (held === null) throw new Error("the protection request never reached the server");
    await (held as () => Promise<void>)();
    prepared.github.writes.length = 0;
    const third = await prepared.runner.produceAndActivate(input);
    expect(third.evidence["stage"]).toBe("activation");
    expect(prepared.github.writes).toEqual([]);
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
    // #246 C3 — the first pre-write check: a bootstrap application needs the run at CEO review.
    expect(refused.reasonCode).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
    expect(refused.evidence).toMatchObject({ stage: "precondition", refusal: "RUN_NOT_AT_CEO_REVIEW" });
    noGitHubCall(prepared);
    expect(prepared.harness.cp.bootstrapApplications.get(prepared.runId)).toBeNull();
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
        list: (...args: Parameters<ArtifactsPort["list"]>) => real.list(...args),
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
