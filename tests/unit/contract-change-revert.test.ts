import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { submittedPlanSchema } from "../../src/bootstrap/plan-input-schema.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { RunKind, RunState } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import {
  type ContractChangeRevertFacts,
  ContractChangeRefusal,
  contractChangeRevert,
  firstActivationPlanForSubmission,
} from "../../src/registry/contract-change-plan.ts";
import { dispatchRun, normalized } from "../helpers/contract-change.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { decideThroughHermes, fixtureManifest, makeHarness, registerFixtureProject, reviewerPass, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1347 — a CONTRACT_CHANGE that added verification is reverted by another CONTRACT_CHANGE whose PLAN
 * names it (`revertsContractChangeRunId`) and carries exactly the manifest it replaced. Only that exact
 * inverse of an additive, completed, latest change of the same project is admitted, once, by CEO CONFIRM
 * alone; every other lowering is still refused. Every PLAN, candidate, review, CONFIRM and activation
 * here goes through the production path.
 */

/** C1 as the issue reproduced it: a required local command added and selected by the standard profile. */
const addsCommand = (id: string, timeoutSeconds = 5) => (base: ProjectManifest): ProjectManifest => normalized({
  ...base,
  verificationCommands: [
    ...base.verificationCommands,
    { ...base.verificationCommands[0]!, id, argv: ["node", `${id}.js`], timeoutSeconds },
  ],
  verificationProfiles: { ...base.verificationProfiles, standard: [...base.verificationProfiles.standard, id] },
});

/** A change that tightens the base's `verify` command: stricter, but not additive. */
const tightensVerify = (base: ProjectManifest): ProjectManifest => normalized({
  ...base,
  verificationCommands: base.verificationCommands.map((command) => (command.id === "verify" ? { ...command, timeoutSeconds: 60 } : command)),
});

const activeManifest = (h: Harness, projectId: string): string | null => h.cp.projects.require(projectId).activeManifestDigest;
const stateOf = (h: Harness, runId: string): RunState => h.cp.runs.require(runId).state;
const grantRow = (h: Harness, runId: string) =>
  h.cp.db.get<Record<string, unknown>>(`SELECT * FROM manifest_activation_grants WHERE run_id = ?`, [runId]) ?? null;
const auditRows = (h: Harness, runId: string) =>
  h.cp.db.all<Record<string, unknown>>(`SELECT * FROM audit_events WHERE run_id = ? ORDER BY event_id`, [runId]);
const activationsOf = (h: Harness, projectId: string) =>
  h.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED").filter((entry) => entry.projectId === projectId);

const runDaemon = async (h: Harness): Promise<void> => {
  const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-cc-revert-") });
  const started = await daemon.start();
  expect(started.allowed, JSON.stringify(started)).toBe(true);
  await daemon.stop();
};

/** plan_submit through the CTO port, carrying `manifest` and, when given, the run it reverts. */
const submit = (h: Harness, runId: string, manifest: ProjectManifest, reverts?: string) =>
  createCtoMcpPort(h.cp).submitPlan(runId, {
    summary: reverts ? "revert the contract change" : "change the project contract",
    projectManifestDigest: manifestDigest(manifest),
    projectManifest: manifest,
    ...(reverts === undefined ? {} : { revertsContractChangeRunId: reverts }),
  });

/** The candidate freeze, review and packet of a run whose PLAN is stored: READY_FOR_CEO_REVIEW, or the refusal. */
const freeze = async (h: Harness, runId: string, manifest: ProjectManifest) => {
  const run = h.cp.runs.require(runId);
  h.scripted.script({ match: /Contract change review/, text: reviewerPass([`${run.projectId}:#manifest/${manifestDigest(manifest)}`]) });
  await h.cp.continuity.evaluate("contract change candidate");
  return h.cp.pipeline.submitResult({
    runId,
    ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "the proposed manifest",
    recommendation: "activate the contract change",
    residualRisk: [],
  });
};

const confirm = async (h: Harness, runId: string) => {
  await h.cp.continuity.evaluate("confirm the contract change");
  return decideThroughHermes(h, {
    runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: h.cp.runs.currentCandidate(runId)!,
    rationale: "contract change revert witness",
  });
};

/** A dispatched CONTRACT_CHANGE run carrying `propose(base)`, reviewed and CEO-confirmed. */
const confirmedChange = async (h: Harness, projectId: string, propose: (base: ProjectManifest) => ProjectManifest, reverts?: string) => {
  const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
  const manifest = propose(run.base);
  const submitted = submit(h, run.runId, manifest, reverts);
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ allowed: true });
  const frozen = await freeze(h, run.runId, manifest);
  expect(frozen, JSON.stringify(frozen)).toMatchObject({ allowed: true });
  expect(stateOf(h, run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
  const confirmed = await confirm(h, run.runId);
  expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ allowed: true, value: { state: RunState.CEO_APPROVED } });
  return { runId: run.runId, base: run.baseDigest, manifest, digest: manifestDigest(manifest) };
};

/**
 * The same, finalized: the project's active manifest is now its manifest. Only this run is finalized,
 * so a run another witness keeps at CEO_APPROVED stays there.
 */
const activatedChange = async (h: Harness, projectId: string, propose: (base: ProjectManifest) => ProjectManifest, reverts?: string) => {
  const change = await confirmedChange(h, projectId, propose, reverts);
  const finalized = await new ApprovedRunFinalizer(h.cp, `activate-${change.runId}`).finalizeApprovedRun(change.runId);
  expect(finalized, JSON.stringify(finalized)).toMatchObject({ allowed: true });
  expect(stateOf(h, change.runId)).toBe(RunState.COMPLETED);
  expect(activeManifest(h, projectId)).toBe(change.digest);
  return change;
};

/** The base X0 a project's first change replaced, read back by digest. */
const manifestOf = (h: Harness, digest: string): ProjectManifest => h.cp.projects.manifest(digest)!;

describe("#1347 W1/W8: the exact inverse of an additive change, end to end", () => {
  it("C1 adds a command; the revert passes plan_submit, freeze, review, CONFIRM and both grant checks; X0 is active again and C1's records are unchanged", async () => {
    const h = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(h, "revert-e2e");
    const x0 = activeManifest(h, projectId)!;
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));
    const c1Run = h.cp.runs.require(c1.runId);
    const c1Grant = grantRow(h, c1.runId);
    const c1Audit = auditRows(h, c1.runId);
    const c1Artifacts = h.cp.db.all(`SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY rowid`, [c1.runId]);
    // A run already pinned to X1 keeps its pin.
    const inFlight = await dispatchRun(h, projectId, RunKind.STANDARD_WORK, [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }]);
    expect(inFlight.baseDigest).toBe(c1.digest);

    // Without the field, the same manifest is the general lowering it always was.
    const general = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    expect(submit(h, general.runId, manifestOf(h, x0))).toMatchObject({
      allowed: false,
      reasonCode: "CANDIDATE_CANNOT_WEAKEN_CONTRACT",
      evidence: { refusal: ContractChangeRefusal.VERIFICATION_BAR_LOWERED, lowered: [{ kind: "COMMAND_REMOVED", commandId: "e2e-wait" }] },
    });

    const revert = await confirmedChange(h, projectId, () => manifestOf(h, x0), c1.runId);
    expect(revert.base).toBe(c1.digest);
    expect(revert.digest).toBe(x0);
    expect(h.cp.artifacts.latest<Record<string, unknown>>(revert.runId, "PLAN")!.content["revertsContractChangeRunId"]).toBe(c1.runId);
    expect(grantRow(h, revert.runId)).toMatchObject({ from_manifest_digest: c1.digest, manifest_digest: x0, consumed_at: null });
    // CEO CONFIRM is the whole gate: no owner decision was asked for.
    expect(h.cp.audit.forRun(revert.runId).filter((entry) => entry.kind === "OWNER_DECISION")).toEqual([]);

    await runDaemon(h);
    expect(stateOf(h, revert.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(h, projectId)).toBe(x0);
    expect(activationsOf(h, projectId).map((entry) => [entry.runId, entry.evidence["from"], entry.evidence["to"]])).toEqual([
      [c1.runId, x0, c1.digest],
      [revert.runId, c1.digest, x0],
    ]);
    expect(grantRow(h, revert.runId)!["consumed_at"]).not.toBeNull();

    // C1's run, grant, artifacts and audit rows, and the in-flight run's pin, are as they were.
    expect(h.cp.runs.require(c1.runId)).toEqual(c1Run);
    expect(grantRow(h, c1.runId)).toEqual(c1Grant);
    expect(auditRows(h, c1.runId)).toEqual(c1Audit);
    expect(h.cp.db.all(`SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY rowid`, [c1.runId])).toEqual(c1Artifacts);
    expect(h.cp.runs.require(inFlight.runId).pinnedManifestDigest).toBe(c1.digest);
    // The next run pins X0 again.
    expect((await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE)).baseDigest).toBe(x0);
  });

  it("the PLAN field survives the plan_submit input schema", () => {
    expect(submittedPlanSchema.parse({ summary: "revert", revertsContractChangeRunId: "run_c1" })).toMatchObject({ revertsContractChangeRunId: "run_c1" });
  });
});

describe("#1347 W2/W6: anything but the exact inverse is refused", () => {
  it("an extra field, or another lowering naming C1, is MANIFEST_MISMATCH; nothing is stored", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "revert-mismatch");
    const x0 = manifestOf(h, activeManifest(h, projectId)!);
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));
    const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    const plansBefore = h.cp.artifacts.latest(run.runId, "PLAN");

    const extra = normalized({ ...x0, postMergeCommands: ["verify"] });
    expect(submit(h, run.runId, extra, c1.runId)).toMatchObject({
      allowed: false,
      reasonCode: "CONTRACT_DIGEST_MISMATCH",
      evidence: { refusal: ContractChangeRefusal.REVERT_MANIFEST_MISMATCH, supplied: manifestDigest(extra), replaced: manifestDigest(x0) },
    });
    // X1 with the added command dropped from the profile only: a lowering, but not X0.
    const partial = normalized({ ...c1.manifest, verificationProfiles: x0.verificationProfiles });
    expect(submit(h, run.runId, partial, c1.runId)).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.REVERT_MANIFEST_MISMATCH },
    });
    // The same lowering without the field is the general refusal.
    expect(submit(h, run.runId, partial)).toMatchObject({ evidence: { refusal: ContractChangeRefusal.VERIFICATION_BAR_LOWERED } });
    expect(h.cp.artifacts.latest(run.runId, "PLAN")).toEqual(plansBefore);
  });
});

describe("#1347 W3: a base that is not C1's result, now and latest, is BASE_STALE", () => {
  it("a stale pin: a run pinned before C1 activated", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "revert-stale-pin");
    const x0 = activeManifest(h, projectId)!;
    const early = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));
    expect(submit(h, early.runId, manifestOf(h, x0), c1.runId)).toMatchObject({
      allowed: false,
      reasonCode: "MANIFEST_PIN_SUPERSEDED",
      evidence: { refusal: ContractChangeRefusal.REVERT_BASE_STALE, pinnedManifestDigest: x0, activated: c1.digest },
    });
  });

  it("C2 activated after C1: refused at plan_submit, at the freeze, and by the grant before the first write", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "revert-c2");
    const x0 = activeManifest(h, projectId)!;
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));

    // Submitted on X1, frozen after C2 moved the project to X2.
    const atFreeze = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    expect(submit(h, atFreeze.runId, manifestOf(h, x0), c1.runId).allowed).toBe(true);
    // Confirmed on X1, finalized after C2.
    const atGrant = await confirmedChange(h, projectId, () => manifestOf(h, x0), c1.runId);

    const c2 = await activatedChange(h, projectId, addsCommand("second"));
    expect(stateOf(h, atGrant.runId)).toBe(RunState.CEO_APPROVED);
    const stale = { allowed: false, reasonCode: "MANIFEST_PIN_SUPERSEDED", evidence: { refusal: ContractChangeRefusal.REVERT_BASE_STALE, active: c2.digest } };
    expect(await freeze(h, atFreeze.runId, manifestOf(h, x0))).toMatchObject(stale);
    expect(await new ApprovedRunFinalizer(h.cp, "revert-c2").finalizeApprovedRun(atGrant.runId)).toMatchObject(stale);
    expect(stateOf(h, atGrant.runId)).toBe(RunState.CEO_APPROVED);
    expect(grantRow(h, atGrant.runId)!["consumed_at"]).toBeNull();
    expect(activeManifest(h, projectId)).toBe(c2.digest);

    // A run pinned to X2 that names C1.
    const late = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    expect(submit(h, late.runId, manifestOf(h, x0), c1.runId)).toMatchObject(stale);
  });

  it("X1 → X2 → X1: C1's manifest is active again, but C1's activation is not the latest", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "revert-abab");
    const x0 = activeManifest(h, projectId)!;
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));
    const c2 = await activatedChange(h, projectId, addsCommand("second"));
    // C2 is additive too, and the latest: its exact inverse is admitted, back to X1.
    await activatedChange(h, projectId, () => manifestOf(h, c1.digest), c2.runId);
    expect(activeManifest(h, projectId)).toBe(c1.digest);

    const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    expect(run.baseDigest).toBe(c1.digest);
    expect(submit(h, run.runId, manifestOf(h, x0), c1.runId)).toMatchObject({
      allowed: false,
      reasonCode: "MANIFEST_PIN_SUPERSEDED",
      evidence: { refusal: ContractChangeRefusal.REVERT_BASE_STALE, active: c1.digest },
    });
  });
});

describe("#1347 W4: a revert authority is used once", () => {
  it("reverting C1 again is ALREADY_USED", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "revert-twice");
    const x0 = activeManifest(h, projectId)!;
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));
    const first = await activatedChange(h, projectId, () => manifestOf(h, x0), c1.runId);

    const again = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    expect(submit(h, again.runId, manifestOf(h, x0), c1.runId)).toMatchObject({
      allowed: false,
      reasonCode: "CONFLICT",
      evidence: { refusal: ContractChangeRefusal.REVERT_ALREADY_USED, revertedBy: [first.runId] },
    });
    // The revert itself lowered the bar, so nothing reverts it back.
    expect(submit(h, again.runId, c1.manifest, first.runId)).toMatchObject({
      allowed: false,
      reasonCode: "CANDIDATE_CANNOT_WEAKEN_CONTRACT",
      evidence: { refusal: ContractChangeRefusal.REVERT_TARGET_NOT_ADDITIVE },
    });
  });
});

describe("#1347 W5: a target that is not a completed, activated, additive CONTRACT_CHANGE of this project", () => {
  it("C1 not COMPLETED, another project's C1, a STANDARD_WORK run, an unknown run; a STANDARD_WORK PLAN naming a revert", async () => {
    const h = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(h, "revert-targets");
    const x0 = activeManifest(h, projectId)!;
    const invalid = (cause: string) => ({
      allowed: false,
      reasonCode: "MANIFEST_ACTIVATION_AUTHORITY_DENIED",
      evidence: { refusal: ContractChangeRefusal.REVERT_TARGET_INVALID, cause },
    });

    // Confirmed but not activated.
    const pending = await confirmedChange(h, projectId, addsCommand("e2e-wait"));
    const reverting = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    expect(submit(h, reverting.runId, manifestOf(h, x0), pending.runId)).toMatchObject(invalid("TARGET_NOT_COMPLETED"));
    expect(submit(h, reverting.runId, manifestOf(h, x0), "run_does_not_exist")).toMatchObject(invalid("TARGET_MISSING"));
    const standard = await dispatchRun(h, projectId, RunKind.STANDARD_WORK, [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }]);
    expect(submit(h, reverting.runId, manifestOf(h, x0), standard.runId)).toMatchObject(invalid("TARGET_NOT_CONTRACT_CHANGE"));
    expect(createCtoMcpPort(h.cp).submitPlan(standard.runId, { summary: "work", revertsContractChangeRunId: pending.runId })).toMatchObject({
      allowed: false,
      reasonCode: "INVALID_ARGUMENT",
      evidence: { refusal: ContractChangeRefusal.REVERT_TARGET_INVALID },
    });

    // Another project's completed, additive C1 (a project with no checkout of its own: the fixture's is taken).
    const otherManifest = fixtureManifest("revert-other");
    const other = { projectId: "revert-other" };
    expect(h.cp.projects.register({ projectId: other.projectId, name: "other", manifest: otherManifest, authorization: h.cp.manifestAuthorizationForTests(otherManifest) }).allowed).toBe(true);
    const otherX0 = activeManifest(h, other.projectId)!;
    const otherC1 = await activatedChange(h, other.projectId, addsCommand("e2e-wait"));
    expect(submit(h, reverting.runId, manifestOf(h, x0), otherC1.runId)).toMatchObject(invalid("TARGET_OTHER_PROJECT"));
    const otherRun = await dispatchRun(h, other.projectId, RunKind.CONTRACT_CHANGE);
    expect(submit(h, otherRun.runId, manifestOf(h, otherX0), otherC1.runId).allowed).toBe(true);

  });

  it("a C1 that tightened an existing command: stricter, but it changed existing verification", async () => {
    const h = makeHarness();
    const tight = await registerFixtureProject(h, "revert-tight");
    const tightX0 = activeManifest(h, tight.projectId)!;
    const tightC1 = await activatedChange(h, tight.projectId, tightensVerify);
    const tightRun = await dispatchRun(h, tight.projectId, RunKind.CONTRACT_CHANGE);
    expect(submit(h, tightRun.runId, manifestOf(h, tightX0), tightC1.runId)).toMatchObject({
      allowed: false,
      reasonCode: "CANDIDATE_CANNOT_WEAKEN_CONTRACT",
      evidence: { refusal: ContractChangeRefusal.REVERT_TARGET_NOT_ADDITIVE, lowered: [], changedCommands: ["verify"] },
    });
  });

  describe("the judgement itself, on facts no production path can reach", () => {
    const x0 = normalized(fixtureManifest("revert-pure"));
    const x1 = addsCommand("e2e-wait")(x0);
    const lowered = normalized({ ...x0, verificationCommands: [{ ...x0.verificationCommands[0]!, timeoutSeconds: 600 }] });
    const stored = new Map([x0, x1, lowered].map((manifest) => [manifestDigest(manifest), manifest]));
    const lookup = (digest: string) => stored.get(digest) ?? null;
    const run = { kind: RunKind.CONTRACT_CHANGE, projectId: "revert-pure", pinnedManifestDigest: manifestDigest(x1) };
    const facts = (overrides: Partial<ContractChangeRevertFacts> = {}, to = manifestDigest(x1)): ContractChangeRevertFacts => ({
      target: { kind: RunKind.CONTRACT_CHANGE, projectId: "revert-pure", state: "COMPLETED" },
      grant: { grantId: "mag_c1", projectId: "revert-pure", fromManifestDigest: manifestDigest(x0), manifestDigest: to, consumed: true, intact: true },
      firstActivation: false,
      activations: [{ eventId: 7, grantId: "mag_c1", from: manifestDigest(x0), to }],
      latestActivationEventId: 7,
      activeManifestDigest: to,
      revertedBy: [],
      ...overrides,
    });
    const judge = (value: ContractChangeRevertFacts | null, pinned = manifestDigest(x1)) =>
      contractChangeRevert({ ...run, pinnedManifestDigest: pinned }, "run_c1", manifestDigest(x0), lookup, value === null ? null : () => value);
    const cause = (decision: ReturnType<typeof judge>) => (decision.allowed ? "ALLOWED" : `${String(decision.evidence["refusal"])}:${String(decision.evidence["cause"] ?? "")}`);

    it("admits the exact inverse; refuses missing facts, a first activation, an unconsumed or altered grant, a disagreeing activation record and a C1 that lowered", () => {
      expect(judge(facts())).toMatchObject({ allowed: true, value: { targetRunId: "run_c1" } });
      expect(cause(judge(null))).toBe(`${ContractChangeRefusal.REVERT_TARGET_INVALID}:FACTS_NOT_SUPPLIED`);
      expect(cause(judge(facts({ firstActivation: true })))).toBe(`${ContractChangeRefusal.REVERT_TARGET_INVALID}:TARGET_FIRST_ACTIVATION`);
      expect(cause(judge(facts({ target: { kind: RunKind.STANDARD_WORK, projectId: "revert-pure", state: "COMPLETED" } }))))
        .toBe(`${ContractChangeRefusal.REVERT_TARGET_INVALID}:TARGET_NOT_CONTRACT_CHANGE`);
      expect(cause(judge(facts({ grant: { ...facts().grant!, consumed: false } })))).toBe(`${ContractChangeRefusal.REVERT_TARGET_INVALID}:TARGET_GRANT_NOT_CONSUMED`);
      expect(cause(judge(facts({ grant: { ...facts().grant!, intact: false } })))).toBe(`${ContractChangeRefusal.REVERT_TARGET_INVALID}:TARGET_GRANT_NOT_CONSUMED`);
      expect(cause(judge(facts({ activations: [] })))).toBe(`${ContractChangeRefusal.REVERT_TARGET_INVALID}:TARGET_ACTIVATION_MISMATCH`);
      expect(cause(judge(facts({ activations: [{ eventId: 7, grantId: "mag_c1", from: manifestDigest(x1), to: manifestDigest(x0) }] }))))
        .toBe(`${ContractChangeRefusal.REVERT_TARGET_INVALID}:TARGET_ACTIVATION_MISMATCH`);
      // A C1 whose move lowered the bar (only a workflow replacement is ever activated that way).
      expect(judge(facts({}, manifestDigest(lowered)), manifestDigest(lowered))).toMatchObject({
        allowed: false,
        evidence: { refusal: ContractChangeRefusal.REVERT_TARGET_NOT_ADDITIVE, lowered: [{ kind: "COMMAND_LIMIT_RAISED", commandId: "verify" }], changedCommands: ["verify"] },
      });
      expect(cause(judge(facts({ latestActivationEventId: 9 })))).toBe(`${ContractChangeRefusal.REVERT_BASE_STALE}:`);
      expect(cause(judge(facts({ revertedBy: ["run_r1"] })))).toBe(`${ContractChangeRefusal.REVERT_ALREADY_USED}:`);
    });

    it("a first-activation PLAN reverts nothing", () => {
      const refused = firstActivationPlanForSubmission(
        { kind: RunKind.CONTRACT_CHANGE, projectId: "revert-pure", pinnedManifestDigest: null },
        { summary: "first", firstActivation: true, projectManifestDigest: manifestDigest(x0), projectManifest: x0, revertsContractChangeRunId: "run_c1" },
        null,
      );
      expect(refused).toMatchObject({ allowed: false, evidence: { refusal: ContractChangeRefusal.REVERT_TARGET_INVALID, cause: "FIRST_ACTIVATION_PLAN" } });
    });
  });
});

describe("#1347 W7: concurrent reverts on one base", () => {
  it("two confirmed reverts of C1: one activates; the other is refused at its activation transaction even past every earlier check; a retry of the winner returns its result", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "revert-race");
    const x0 = activeManifest(h, projectId)!;
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));
    const a = await confirmedChange(h, projectId, () => manifestOf(h, x0), c1.runId);
    const b = await confirmedChange(h, projectId, () => manifestOf(h, x0), c1.runId);

    // The finalizer's overlap guard is taken away, so the compare-and-set and the consumption are all
    // that stand between the two. A passes PRE_MERGE and the activation check outside the transaction;
    // then B finalizes completely; then A's activation transaction runs.
    vi.spyOn(h.cp.manifestGrants, "finalizingContractChanges").mockReturnValue([]);
    const finalizer = ApprovedRunFinalizer.prototype as unknown as { compareActivationWorkflows: (runId: string, ...rest: unknown[]) => Promise<unknown> };
    const compare = finalizer.compareActivationWorkflows;
    let winner: Awaited<ReturnType<ApprovedRunFinalizer["finalizeApprovedRun"]>> | null = null;
    vi.spyOn(finalizer, "compareActivationWorkflows").mockImplementation(async function (this: unknown, runId: string, ...rest: unknown[]) {
      // Only the comparison `complete` asks for, after its activation check and before its transaction.
      if (runId === a.runId && rest.length === 1 && winner === null) winner = await new ApprovedRunFinalizer(h.cp, "revert-race-b").finalizeApprovedRun(b.runId);
      return compare.call(this, runId, ...rest);
    });
    const loser = await new ApprovedRunFinalizer(h.cp, "revert-race-a").finalizeApprovedRun(a.runId);
    vi.restoreAllMocks();

    expect(winner, JSON.stringify(winner)).toMatchObject({ allowed: true });
    expect(stateOf(h, b.runId)).toBe(RunState.COMPLETED);
    expect(loser.allowed).toBe(false);
    expect(JSON.stringify(loser)).toContain(ContractChangeRefusal.REVERT_ALREADY_USED);
    expect(activeManifest(h, projectId)).toBe(x0);
    expect(grantRow(h, a.runId)!["consumed_at"]).toBeNull();
    expect(grantRow(h, b.runId)!["consumed_at"]).not.toBeNull();
    expect(activationsOf(h, projectId).map((entry) => entry.runId)).toEqual([c1.runId, b.runId]);

    // A retry of the winner returns its existing result and changes nothing.
    const before = { grant: grantRow(h, b.runId), activations: activationsOf(h, projectId).length };
    const replay = await new ApprovedRunFinalizer(h.cp, "revert-race-b-again").finalizeApprovedRun(b.runId);
    expect(replay).toMatchObject({ allowed: true, reasonCode: "MERGE_IDEMPOTENT_REPLAY" });
    expect({ grant: grantRow(h, b.runId), activations: activationsOf(h, projectId).length }).toEqual(before);
    // And the loser, asked again, is refused before any write.
    expect(await new ApprovedRunFinalizer(h.cp, "revert-race-a-again").finalizeApprovedRun(a.runId)).toMatchObject({ allowed: false });
    expect(activeManifest(h, projectId)).toBe(x0);
  });

  it("with the overlap guard in place: one finalizes, the other is held, then refused ALREADY_USED before any write", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "revert-overlap");
    const x0 = activeManifest(h, projectId)!;
    const c1 = await activatedChange(h, projectId, addsCommand("e2e-wait"));
    const a = await confirmedChange(h, projectId, () => manifestOf(h, x0), c1.runId);
    const b = await confirmedChange(h, projectId, () => manifestOf(h, x0), c1.runId);
    const [ra, rb] = await Promise.all([
      new ApprovedRunFinalizer(h.cp, "revert-overlap-a").finalizeApprovedRun(a.runId),
      new ApprovedRunFinalizer(h.cp, "revert-overlap-b").finalizeApprovedRun(b.runId),
    ]);
    expect(ra.allowed).toBe(true);
    expect(rb).toMatchObject({ allowed: false, reasonCode: "CONTRACT_CHANGE_FINALIZATION_OVERLAP" });
    expect(await new ApprovedRunFinalizer(h.cp, "revert-overlap-b-later").finalizeApprovedRun(b.runId)).toMatchObject({
      allowed: false,
      reasonCode: "CONFLICT",
      evidence: { refusal: ContractChangeRefusal.REVERT_ALREADY_USED, revertedBy: [a.runId] },
    });
    expect(stateOf(h, b.runId)).toBe(RunState.CEO_APPROVED);
    expect(grantRow(h, b.runId)!["consumed_at"]).toBeNull();
    expect(activeManifest(h, projectId)).toBe(x0);
  });
});
