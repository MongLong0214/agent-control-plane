import { createConnection, type Socket } from "node:net";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import * as liveness from "../../src/daemon/dead-binding-recovery.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { createHermesMcpPort } from "../../src/mcp/hermes-server.ts";
import type { AuthenticatedTargetBinding, AuthenticatedTargetTuple } from "../../src/session/binding-registry.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { WORKFLOW, WORKFLOW_PATH, dispatchRun, normalized, stricter, type DispatchedRun } from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindWorker,
  carryContractChange,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 B2-b — a CONTRACT_CHANGE run's CEO CONFIRM issues one activation grant, and the daemon
 * finalizer consumes it in the one transaction that moves the project's active manifest from the run's
 * pin to the manifest its PLAN carries and completes the run.
 *
 * Every grant, state edge and pointer move here goes through the production path: plan_submit through
 * the CTO MCP port's routing, the candidate pipeline and blind review, the CEO decision (in process, or
 * through the Hermes MCP port or socket where the door is the point), and the daemon finalizer. Raw SQL
 * appears only where the raw write is itself the attack, and the expectation is its refusal or, for a
 * documented Limit, what still stops it.
 *
 * New reason codes are written as literals so this file runs, and fails on its assertions, against a
 * tree that predates them.
 */

interface GrantRow {
  grant_id: string;
  run_id: string;
  project_id: string;
  manifest_digest: string;
  from_manifest_digest: string;
  plan_digest: string;
  candidate_snapshot_digest: string;
  ceo_actor_id: string;
  ceo_session_id: string;
  ceo_binding_generation: number;
  grant_digest: string;
  consumed_at: string | null;
  consumed_attempt_id: string | null;
}

const grantRow = (h: Harness, runId: string): GrantRow | null =>
  h.cp.db.get<GrantRow>(`SELECT * FROM manifest_activation_grants WHERE run_id = ?`, [runId]) ?? null;

const activeManifest = (h: Harness, projectId: string): string | null => h.cp.projects.require(projectId).activeManifestDigest;

const stateOf = (h: Harness, runId: string): RunState => h.cp.runs.require(runId).state;

const activations = (h: Harness) => h.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED");

const lastFailure = (h: Harness, runId: string) =>
  h.cp.audit.forRun(runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED").at(-1) ?? null;

const runDaemon = async (h: Harness, prefix = "acp-cc-activate-"): Promise<void> => {
  const daemon = new Daemon(h.cp, { stateDir: tempDir(prefix) });
  const started = await daemon.start();
  expect(started.allowed, JSON.stringify(started)).toBe(true);
  await daemon.stop();
};

/** M1 with a stricter CommitLore mode only: it names no workflow, so activation reads nothing. */
const commitloreRequired = (base: ProjectManifest): ProjectManifest => normalized({ ...base, commitlore: { mode: "required" } });

/** A stricter manifest that keeps every workflow as it is and adds one post-merge check. */
const postMergeAdded = (name: string) => (base: ProjectManifest): ProjectManifest =>
  normalized({ ...base, postMergeCommands: [...base.postMergeCommands, name] });

/**
 * A dispatched CONTRACT_CHANGE run with no repositories, its PLAN carrying `propose(base)`, reviewed and
 * published: READY_FOR_CEO_REVIEW, with nobody having decided.
 */
const readyContractChange = async (
  h: Harness,
  projectId: string,
  propose: (base: ProjectManifest) => ProjectManifest = commitloreRequired,
): Promise<{ run: DispatchedRun; proposed: ProjectManifest; candidate: string }> => {
  const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
  const proposed = carryContractChange(h, run.runId, propose(run.base));
  await h.cp.continuity.evaluate("contract change candidate");
  const submitted = await h.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    resultSummary: "the proposed manifest",
    recommendation: "activate the contract change",
    residualRisk: [],
  });
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  expect(stateOf(h, run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
  return { run, proposed, candidate: h.cp.runs.currentCandidate(run.runId)! };
};

const confirm = async (h: Harness, runId: string, candidate: string, ceoSessionId?: string) => {
  await h.cp.continuity.evaluate("confirm the contract change");
  return h.cp.ceo.submitCeoDecision({
    runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: candidate,
    ceoSessionId: ceoSessionId ?? h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId,
    rationale: "contract change witness",
  });
};

/** A harness whose GitHub is the fake, with the fixture project's `dev` branch carrying `content`. */
const githubHarness = () => {
  const github = new FakeGitHub();
  const harness = makeHarness({ githubClient: github });
  return { github, harness };
};

const publishOnDev = (h: Harness, github: FakeGitHub, content: string = WORKFLOW): string => {
  writeFiles(h.repoPath, { [WORKFLOW_PATH]: content });
  const sha = commitAll(h.repoPath, "the workflow on dev");
  github.setBranch("dev", sha);
  return sha;
};

/** Every GitHub request the fake receives, by method and path. */
const recordRequests = (github: FakeGitHub): string[] => {
  const seen: string[] = [];
  const request = github.request.bind(github);
  github.request = async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
    seen.push(`${method} ${path}`);
    return request<T>(method, path, body);
  };
  return seen;
};

describe("the normal path: CONFIRM → grant → one transaction that activates, consumes and completes", () => {
  it("E2E (no repositories): the grant is issued at CONFIRM and consumed with COMPLETED, M0 → M1, workflow compared first", async () => {
    const { github, harness } = githubHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness, "cc-e2e");
    const devHead = publishOnDev(harness, github);
    const { run, proposed, candidate } = await readyContractChange(harness, projectId, stricter);
    const m0 = run.baseDigest;
    const m1 = manifestDigest(proposed);
    expect(activeManifest(harness, projectId)).toBe(m0);

    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const confirmed = await confirm(harness, run.runId, candidate);
    expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ allowed: true, value: { state: RunState.CEO_APPROVED } });
    const issued = grantRow(harness, run.runId)!;
    expect(issued).toMatchObject({
      project_id: projectId,
      manifest_digest: m1,
      from_manifest_digest: m0,
      candidate_snapshot_digest: candidate,
      ceo_session_id: ceo.sessionId,
      ceo_binding_generation: ceo.bindingGeneration,
      consumed_at: null,
    });
    const decision = harness.cp.audit.forRun(run.runId).find((entry) => entry.kind === "CEO_DECISION")!;
    expect(decision.evidence["manifestActivationGrantDigest"]).toBe(issued.grant_digest);
    // Confirmed, not yet activated.
    expect(activeManifest(harness, projectId)).toBe(m0);

    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, projectId)).toBe(m1);
    const consumed = grantRow(harness, run.runId)!;
    const attempt = harness.cp.db.get<{ attempt_id: string; state: string }>(
      `SELECT attempt_id, state FROM finalization_attempts WHERE run_id = ?`,
      [run.runId],
    )!;
    expect(consumed.consumed_at).not.toBeNull();
    expect(consumed.consumed_attempt_id).toBe(attempt.attempt_id);
    expect(activations(harness)).toHaveLength(1);
    expect(activations(harness)[0]!.evidence).toMatchObject({
      from: m0,
      to: m1,
      grantId: consumed.grant_id,
      grantDigest: consumed.grant_digest,
      attemptId: attempt.attempt_id,
      workflows: [{ path: WORKFLOW_PATH, evidence: "READ", revision: devHead, observedDigest: sha256(WORKFLOW) }],
    });
    // COMPLETED names the activation it committed with.
    const completed = harness.cp.audit
      .forRun(run.runId)
      .find((entry) => entry.kind === "RUN_TRANSITION" && entry.evidence["to"] === RunState.COMPLETED)!;
    expect(completed.evidence["manifestActivation"]).toEqual({ from: m0, to: m1, grantId: consumed.grant_id });
    expect(harness.cp.repositories.byId(repositoryId)).toMatchObject({ activeManifestDigest: m1, driftState: "DRIFTED" });
    expect(harness.cp.projects.manifest(m1)).toEqual(proposed);

    // The next run pins M1: the tests and CI M1 requires are its bar, not git status alone.
    const next = await dispatchRun(harness, projectId, RunKind.STANDARD_WORK, [
      { repositoryId, repositoryRole: "primary", baseBranch: "dev" },
    ]);
    expect(next.baseDigest).toBe(m1);
    expect(next.base.verificationCommands.map((command) => command.id)).toEqual(["verify", "unit-tests"]);
    expect(next.base.verificationCommands.find((command) => command.id === "unit-tests")?.evidenceMode).toBe("BOTH_REQUIRED");
    expect(next.base.ciWorkflows.map((workflow) => workflow.checkName)).toEqual(["unit-tests"]);
  });

  it("E2E (Hermes MCP port): the door's authenticated session is the grant's CEO session", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-e2e-port");
    const { run, proposed, candidate } = await readyContractChange(harness, projectId);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    await harness.cp.continuity.evaluate("port confirm");
    const port = createHermesMcpPort(harness.cp);
    const confirmed = await port.submitCeoDecision({
      runId: run.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: candidate,
      ceoSessionId: ceo.sessionId,
      rationale: "through the Hermes port",
      ingress: { sessionId: ceo.sessionId, sessionIncarnation: ceo.sessionIncarnation },
    });
    expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ allowed: true, value: { state: RunState.CEO_APPROVED } });
    expect(grantRow(harness, run.runId)!.ceo_session_id).toBe(ceo.sessionId);
    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(proposed));
  });
});

describe("a stale pin, a base mismatch and two CONTRACT_CHANGEs on one base", () => {
  it("ruling 1 / W14: a second CONFIRM while the first finalizes is an overlap; after activation it is MANIFEST_PIN_SUPERSEDED; a recreated run works", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-stale-pin");
    const ra = await readyContractChange(harness, projectId, commitloreRequired);
    const rb = await readyContractChange(harness, projectId, postMergeAdded("rb-check"));
    expect(rb.run.baseDigest).toBe(ra.run.baseDigest);

    expect((await confirm(harness, ra.run.runId, ra.candidate)).allowed).toBe(true);
    const overlap = await confirm(harness, rb.run.runId, rb.candidate);
    expect(overlap).toMatchObject({ allowed: false, reasonCode: "CONTRACT_CHANGE_FINALIZATION_OVERLAP" });
    expect(stateOf(harness, rb.run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(grantRow(harness, rb.run.runId)).toBeNull();

    await runDaemon(harness);
    const m1 = manifestDigest(ra.proposed);
    expect(activeManifest(harness, projectId)).toBe(m1);

    // Rb was judged against M0, which is no longer the active manifest: it is refused, not re-pinned.
    const stale = await confirm(harness, rb.run.runId, rb.candidate);
    expect(stale).toMatchObject({ allowed: false, reasonCode: "MANIFEST_PIN_SUPERSEDED" });
    expect(stale.evidence).toMatchObject({ base: ra.run.baseDigest, active: m1 });
    expect(stateOf(harness, rb.run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(grantRow(harness, rb.run.runId)).toBeNull();
    expect(rb.run.base).toEqual(harness.cp.projects.manifest(ra.run.baseDigest));

    // Recreated, it pins M1 and finalizes normally.
    const again = await readyContractChange(harness, projectId, postMergeAdded("rb-check"));
    expect(again.run.baseDigest).toBe(m1);
    expect((await confirm(harness, again.run.runId, again.candidate)).allowed).toBe(true);
    await runDaemon(harness);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(again.proposed));
    expect(activations(harness).map((entry) => [entry.evidence["from"], entry.evidence["to"]])).toEqual([
      [ra.run.baseDigest, m1],
      [m1, manifestDigest(again.proposed)],
    ]);
  });

  it("base compare-and-set: two grants on one base racing past the overlap check — the pointer moves once, the loser activates nothing", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-cas");
    const ra = await readyContractChange(harness, projectId, commitloreRequired);
    const rb = await readyContractChange(harness, projectId, postMergeAdded("rb-check"));
    // Simulates two CONFIRMs admitted before either saw the other finalizing.
    vi.spyOn(harness.cp.manifestGrants, "finalizingContractChanges").mockReturnValue([]);
    expect((await confirm(harness, ra.run.runId, ra.candidate)).allowed).toBe(true);
    expect((await confirm(harness, rb.run.runId, rb.candidate)).allowed).toBe(true);
    expect(grantRow(harness, ra.run.runId)!.from_manifest_digest).toBe(grantRow(harness, rb.run.runId)!.from_manifest_digest);

    const finalizerA = new ApprovedRunFinalizer(harness.cp, "witness-a");
    const finalizerB = new ApprovedRunFinalizer(harness.cp, "witness-b");
    const [a, b] = await Promise.all([finalizerA.finalizeApprovedRun(ra.run.runId), finalizerB.finalizeApprovedRun(rb.run.runId)]);
    const results = [
      { runId: ra.run.runId, outcome: a, proposed: ra.proposed },
      { runId: rb.run.runId, outcome: b, proposed: rb.proposed },
    ];
    const winners = results.filter((entry) => entry.outcome.allowed);
    const losers = results.filter((entry) => !entry.outcome.allowed);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(winners[0]!.proposed));
    expect(activations(harness)).toHaveLength(1);
    const loser = losers[0]!;
    expect(stateOf(harness, loser.runId)).not.toBe(RunState.COMPLETED);
    expect(grantRow(harness, loser.runId)!.consumed_at).toBeNull();
    // Refused on the base, whether at PRE_MERGE or inside the activation transaction.
    expect(JSON.stringify(loser.outcome)).toContain("MANIFEST_PIN_SUPERSEDED");
  });
});

describe("a grant is consumed once, and a refusal leaves nothing partial", () => {
  it("a second consumption has no effect: a re-entered finalizer, a direct activation and a raw consume all change nothing", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-twice");
    const { run, proposed, candidate } = await readyContractChange(harness, projectId);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    await runDaemon(harness);
    const m1 = manifestDigest(proposed);
    const consumed = grantRow(harness, run.runId)!;
    expect(activeManifest(harness, projectId)).toBe(m1);
    const auditBefore = harness.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'PROJECT_MANIFEST_ACTIVATED'")!.n;

    await runDaemon(harness, "acp-cc-twice-again-");
    const replay = await new ApprovedRunFinalizer(harness.cp, "witness-replay").finalizeApprovedRun(run.runId);
    expect(replay.allowed).toBe(true);
    expect(replay.reasonCode).toBe("MERGE_IDEMPOTENT_REPLAY");
    const direct = harness.cp.projects.activateManifest(run.runId, {
      completion: harness.cp.daemonFinalizationAuthorities().completion,
      attemptId: consumed.consumed_attempt_id!,
      workflows: [],
    });
    expect(direct).toMatchObject({ allowed: false, reasonCode: "MANIFEST_ACTIVATION_GRANT_CONSUMED" });
    expect(() =>
      harness.cp.db.run(`UPDATE manifest_activation_grants SET consumed_at = ?, consumed_attempt_id = ? WHERE run_id = ?`, [
        harness.clock.nowIso(),
        "finalize_forged",
        run.runId,
      ]),
    ).toThrow(/MANIFEST_GRANT_CONSUMED/);

    expect(grantRow(harness, run.runId)).toEqual(consumed);
    expect(activeManifest(harness, projectId)).toBe(m1);
    expect(harness.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'PROJECT_MANIFEST_ACTIVATED'")!.n).toBe(auditBefore);
  });

  it("W13a: a failure inside the completion transaction after the pointer moved rolls back pointer, consumption, drift, audit and state; the retry activates", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness, "cc-rollback");
    const { run, proposed, candidate } = await readyContractChange(harness, projectId);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    const repositoryBefore = harness.cp.repositories.byId(repositoryId)!;
    const record = harness.cp.audit.record.bind(harness.cp.audit);
    let thrown = 0;
    vi.spyOn(harness.cp.audit, "record").mockImplementation((event) => {
      if (event.kind === "PROJECT_MANIFEST_ACTIVATED" && thrown === 0) {
        thrown += 1;
        throw new Error("injected audit failure after the pointer update");
      }
      return record(event);
    });

    // One finalization attempt, so the state it leaves is observed before any retry.
    const attempt = await new ApprovedRunFinalizer(harness.cp, "witness-rollback").finalizeApprovedRun(run.runId);
    expect(attempt.allowed).toBe(false);
    expect(thrown).toBe(1);
    expect(stateOf(harness, run.runId)).toBe(RunState.POST_MERGE_VERIFYING);
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
    expect(grantRow(harness, run.runId)!.consumed_at).toBeNull();
    expect(harness.cp.repositories.byId(repositoryId)).toMatchObject({
      activeManifestDigest: repositoryBefore.activeManifestDigest,
      driftState: repositoryBefore.driftState,
    });
    expect(activations(harness)).toEqual([]);
    expect(harness.cp.projects.manifest(manifestDigest(proposed))).toBeNull();
    expect(harness.cp.audit.forRun(run.runId).some((entry) => entry.kind === "RUN_TRANSITION" && entry.evidence["to"] === RunState.COMPLETED)).toBe(false);

    // Unconsumed, the grant still activates on the retry.
    await runDaemon(harness, "acp-cc-rollback-retry-");
    expect(stateOf(harness, run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(proposed));
    expect(grantRow(harness, run.runId)!.consumed_at).not.toBeNull();
  });

  it("W13b: a finalizer that skips activation cannot complete a CONTRACT_CHANGE — refused by code, and by the v44 trigger", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-skip");
    const { run, candidate } = await readyContractChange(harness, projectId);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    vi.spyOn(harness.cp.projects, "activateManifest").mockReturnValue(allow("OK", { from: "skipped", to: "skipped", grantId: "skipped" }));
    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.POST_MERGE_VERIFYING);
    expect(JSON.stringify(lastFailure(harness, run.runId))).toContain("CONTRACT_CHANGE_NOT_ACTIVATED");
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);

    // The code check answered first. With it answering yes, the v44 trigger still refuses the write.
    const get = harness.cp.db.get.bind(harness.cp.db);
    vi.spyOn(harness.cp.db, "get").mockImplementation(((sql: string, params?: unknown[]) =>
      sql.includes("FROM manifest_activation_grants g") ? { n: 1 } : get(sql, params)) as typeof harness.cp.db.get);
    const completion = harness.cp.daemonFinalizationAuthorities().completion;
    expect(() => harness.cp.runs.transition(run.runId, RunState.COMPLETED, "witness: no activation", {}, completion))
      .toThrow(/CONTRACT_CHANGE_NOT_ACTIVATED/);
    expect(stateOf(harness, run.runId)).toBe(RunState.POST_MERGE_VERIFYING);
  });
});

/** A CEO bound on a session whose process the restoration probe can declare dead (12345). */
const bindRestorableCeo = (h: Harness) => {
  const old = h.cp.sessions.create({ provider: "hermes", model: "test", osPid: 12345 });
  h.cp.sessions.transition(old.sessionId, SessionLifecycle.READY, "fixture");
  const first = h.cp.bindings.bind({ role: Role.CEO, sessionId: old.sessionId });
  if (!first.allowed) throw new Error(first.message);
  const actorId = h.cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE assignment_id = ?", [first.value.assignmentId])!.actor_id;
  return { old, actorId, generation: first.value.bindingGeneration };
};

/** The owner's same-actor restoration after the CEO runtime died: a new session, a new generation, the same actor. */
const readoptSameActor = (h: Harness, ceo: ReturnType<typeof bindRestorableCeo>) => {
  h.cp.bindings.revoke(roleKeyFor(Role.CEO), "runtime died");
  h.cp.sessions.transition(ceo.old.sessionId, SessionLifecycle.ERROR, "runtime died");
  const replacement = h.cp.sessions.create({ provider: "hermes", model: "test", osPid: process.pid });
  h.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "replacement");
  vi.spyOn(liveness, "probeSessionLiveness").mockImplementation((pid) => (pid === process.pid ? "ALIVE" : "DEAD"));
  const claimed = { executorKind: "hermes", targetLocator: "canonical-session", targetLocatorDigest: digestOf({ root: "canonical" }) };
  let receipt: unknown;
  const authenticatedTarget: AuthenticatedTargetBinding = {
    claimed,
    protocolVersion: "hermes.target-bind/v1",
    expectedExecutorRuntimeIdentity: "runtime:test",
    get targetBindReceipt() { return receipt; },
    get attestationDigest() { return (receipt as { receipt_digest: string }).receipt_digest; },
    verify(tuple: AuthenticatedTargetTuple) {
      const fields = { domain: "hermes.target-bind", version: 1, actor_id: tuple.actorId, binding_generation: tuple.generation,
        executor_runtime_identity: "runtime:test", requested_session_id: claimed.targetLocator, lineage_root_digest: claimed.targetLocatorDigest };
      receipt = { ...fields, receipt_digest: digestOf(fields) };
      return claimed;
    },
  };
  const restored = h.cp.bindings.bind({
    role: Role.CEO,
    sessionId: replacement.sessionId,
    authenticatedTarget,
    restoreCeo: { actorId: ceo.actorId, generation: ceo.generation, sessionId: ceo.old.sessionId, incarnation: ceo.old.incarnation },
  });
  if (!restored.allowed) throw new Error(`${restored.reasonCode}: ${restored.message}`);
  return restored.value;
};

/** A different CEO actor, bound the way a switchover binds it. */
const switchToAnotherCeo = (h: Harness, model: string) => {
  const created = h.cp.sessions.create({ provider: "scripted", model });
  h.cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "another CEO");
  const switched = h.cp.bindings.switchTo({ role: Role.CEO, sessionId: created.sessionId, reason: "another CEO", conversation: "REPLACED" });
  if (!switched.allowed) throw new Error(switched.message);
  if (!created.sessionSecret) throw new Error("fixture session has no secret");
  return { sessionId: created.sessionId, sessionSecret: created.sessionSecret };
};

describe("ruling 2: consumption authenticates the live CEO binding", () => {
  it("the CEO role moved to another actor after CONFIRM: PRE_MERGE refuses, nothing is activated or completed", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-ceo-moved");
    const { run, candidate } = await readyContractChange(harness, projectId);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    const granted = grantRow(harness, run.runId)!;
    switchToAnotherCeo(harness, "another-ceo");
    expect(harness.cp.db.get<{ actor_id: string }>(
      "SELECT actor_id FROM assignments WHERE role_key = 'CEO' AND status = 'ACTIVE'",
    )!.actor_id).not.toBe(granted.ceo_actor_id);

    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.CEO_APPROVED);
    expect(lastFailure(harness, run.runId)?.reasonCode).toBe("MANIFEST_ACTIVATION_AUTHORITY_STALE");
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
    expect(grantRow(harness, run.runId)!.consumed_at).toBeNull();
  });

  it("no live CEO binding at consumption: refused", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-ceo-gone");
    const { run, candidate } = await readyContractChange(harness, projectId);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "the CEO left").allowed).toBe(true);
    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).not.toBe(RunState.COMPLETED);
    expect(JSON.stringify(lastFailure(harness, run.runId))).toContain("MANIFEST_ACTIVATION_AUTHORITY_STALE");
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
  });

  it("an official same-actor re-adoption (a new generation) is not a reason to re-approve: the grant activates", async () => {
    const harness = makeHarness();
    const ceo = bindRestorableCeo(harness);
    const { projectId } = await registerFixtureProject(harness, "cc-ceo-readopted");
    const { run, proposed, candidate } = await readyContractChange(harness, projectId);
    expect((await confirm(harness, run.runId, candidate, ceo.old.sessionId)).allowed).toBe(true);
    const restored = readoptSameActor(harness, ceo);
    expect(restored.bindingGeneration).toBeGreaterThan(ceo.generation);
    expect(harness.cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE assignment_id = ?", [restored.assignmentId])!.actor_id).toBe(ceo.actorId);

    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(proposed));
  });

  it("a stale call from the earlier session after re-adoption is refused at CONFIRM: no grant", async () => {
    const harness = makeHarness();
    const ceo = bindRestorableCeo(harness);
    const { projectId } = await registerFixtureProject(harness, "cc-ceo-stale-call");
    const { run, candidate } = await readyContractChange(harness, projectId);
    readoptSameActor(harness, ceo);
    const stale = await confirm(harness, run.runId, candidate, ceo.old.sessionId);
    expect(stale.allowed).toBe(false);
    expect(stateOf(harness, run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(grantRow(harness, run.runId)).toBeNull();
  });
});

describe("ruling 6: every workflow the manifest points to is compared before activation", () => {
  it("bytes at the exact revision that are not the approved ones refuse before anything is written; corrected, the same grant activates", async () => {
    const { github, harness } = githubHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-workflow-mismatch");
    const tampered = `${WORKFLOW}# not the approved bytes\n`;
    const wrongHead = publishOnDev(harness, github, tampered);
    const { run, proposed, candidate } = await readyContractChange(harness, projectId, stricter);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);

    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.CEO_APPROVED);
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
    expect(grantRow(harness, run.runId)!.consumed_at).toBeNull();
    expect(activations(harness)).toEqual([]);
    const failure = lastFailure(harness, run.runId)!;
    expect(failure.reasonCode).toBe("MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED");
    expect(failure.evidence).toMatchObject({ revision: wrongHead, observedDigest: sha256(tampered) });

    const rightHead = publishOnDev(harness, github, WORKFLOW);
    await runDaemon(harness, "acp-cc-workflow-fixed-");
    expect(stateOf(harness, run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(proposed));
    expect(activations(harness)[0]!.evidence["workflows"]).toEqual([
      expect.objectContaining({ evidence: "READ", revision: rightHead, observedDigest: sha256(WORKFLOW) }),
    ]);
  });

  it("the branch moves after the pre-merge comparison: activation compares again, outside its transaction, and refuses; the pointer does not move", async () => {
    const { github, harness } = githubHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-workflow-moved");
    publishOnDev(harness, github, WORKFLOW);
    const { run, candidate } = await readyContractChange(harness, projectId, stricter);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    const tampered = `${WORKFLOW}# moved after the first comparison\n`;
    writeFiles(harness.repoPath, { [WORKFLOW_PATH]: tampered });
    const movedHead = commitAll(harness.repoPath, "the workflow changes on dev");
    // The first read of `dev` (the pre-merge comparison) sees the approved bytes; then `dev` moves.
    const request = github.request.bind(github);
    let refReads = 0;
    github.request = async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
      const answer = await request<T>(method, path, body);
      if (method === "GET" && /\/git\/ref\/heads\/dev$/.test(path) && ++refReads === 1) github.setBranch("dev", movedHead);
      return answer;
    };
    const attempt = await new ApprovedRunFinalizer(harness.cp, "witness-moved").finalizeApprovedRun(run.runId);
    expect(attempt.allowed).toBe(false);
    expect(refReads).toBe(2);
    expect(stateOf(harness, run.runId)).toBe(RunState.POST_MERGE_VERIFYING);
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
    expect(grantRow(harness, run.runId)!.consumed_at).toBeNull();
    const failure = lastFailure(harness, run.runId)!;
    expect(failure.reasonCode).toBe("MANIFEST_ACTIVATION_REFUSED");
    expect(failure.evidence["refusal"]).toMatchObject({
      reasonCode: "MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED",
      evidence: { revision: movedHead, observedDigest: sha256(tampered) },
    });
  });

  it("a workflow that cannot be read refuses activation: an unverifiable contract is never activated", async () => {
    const { github, harness } = githubHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-workflow-unreadable");
    // `dev` names a commit that carries no workflow file, locally or on GitHub.
    gitSync(harness.repoPath, ["commit", "-q", "--allow-empty", "-m", "no workflow here"]);
    github.setBranch("dev", gitSync(harness.repoPath, ["rev-parse", "HEAD"]).trim());
    const { run, candidate } = await readyContractChange(harness, projectId, stricter);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.CEO_APPROVED);
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
    expect(lastFailure(harness, run.runId)!.reasonCode).toBe("MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED");
  });

  it("no workflow changed: the base's exact-byte approval is reused and GitHub is not read", async () => {
    const { github, harness } = githubHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-workflow-reused", {
      ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "unit-tests", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
    });
    const requests = recordRequests(github);
    const { run, proposed, candidate } = await readyContractChange(harness, projectId, postMergeAdded("extra-check"));
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(proposed));
    expect(activations(harness)[0]!.evidence["workflows"]).toEqual([
      expect.objectContaining({ path: WORKFLOW_PATH, evidence: "REUSED", revision: null, observedDigest: null }),
    ]);
    expect(requests.filter((request) => /\/contents\/|\/git\/ref\/heads\//.test(request))).toEqual([]);
  });
});

describe("forged rows and raw writes", () => {
  it("W5/W1: a generic CEO_APPROVED edge, a forged CEO_DECISION row and a forged APPROVAL row finalize nothing", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-forged");
    const { run, proposed, candidate } = await readyContractChange(harness, projectId);
    expect(harness.cp.runs.transition(run.runId, RunState.CEO_APPROVED, "witness: no decision", { candidateSnapshotDigest: candidate }).allowed).toBe(true);
    harness.cp.db.run(
      `INSERT INTO audit_events (at, kind, run_id, session_id, evidence_json) VALUES (?, 'CEO_DECISION', ?, 'nobody', ?)`,
      [harness.clock.nowIso(), run.runId, JSON.stringify({ decision: "CONFIRM", candidateSnapshotDigest: candidate, rationale: "forged" })],
    );
    const forgedGrant = {
      schema: "acp.manifest-activation-grant.v1",
      projectId,
      runId: run.runId,
      runKind: "CONTRACT_CHANGE",
      manifestDigest: manifestDigest(proposed),
      candidateSnapshotDigest: candidate,
    };
    harness.cp.db.run(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'APPROVAL', ?, ?, ?, 'production-gate', ?)`,
      [`art_forged_${run.runId.slice(-12)}`, run.runId, digestOf(forgedGrant), candidate, JSON.stringify(forgedGrant), harness.clock.nowIso()],
    );
    expect(harness.cp.ceo.currentCeoConfirmation(run.runId, candidate).allowed).toBe(true);

    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.CEO_APPROVED);
    expect(lastFailure(harness, run.runId)?.reasonCode).toBe("MANIFEST_ACTIVATION_GRANT_MISSING");
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
    expect(grantRow(harness, run.runId)).toBeNull();
  });

  it("W3: a forged PROJECT_MANIFEST_ACTIVATED row naming the grant is not consumption, and vetoes nothing", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-forged-audit");
    const { run, proposed, candidate } = await readyContractChange(harness, projectId);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(true);
    const grant = grantRow(harness, run.runId)!;
    harness.cp.audit.record({ kind: "PROJECT_MANIFEST_ACTIVATED", projectId, runId: run.runId, evidence: { grantId: grant.grant_id, activationGrantDigest: grant.grant_digest } });
    harness.cp.db.run(
      `INSERT INTO audit_events (at, kind, run_id, session_id, evidence_json) VALUES (?, 'PROJECT_MANIFEST_ACTIVATED', ?, NULL, ?)`,
      [harness.clock.nowIso(), run.runId, JSON.stringify({ grantId: grant.grant_id, activationGrantDigest: grant.grant_digest })],
    );
    await runDaemon(harness);
    expect(stateOf(harness, run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, projectId)).toBe(manifestDigest(proposed));
  });

  it("W4: a raw UPDATE of a project's active manifest is refused by the v44 guard", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-raw-pointer");
    const stored = harness.cp.projects.storeManifest(
      commitloreRequired(harness.cp.projects.activeManifest(projectId)!.manifest),
      harness.cp.manifestAuthorizationForTests(commitloreRequired(harness.cp.projects.activeManifest(projectId)!.manifest)),
    );
    if (!stored.allowed) throw new Error(stored.message);
    const before = activeManifest(harness, projectId);
    expect(() =>
      harness.cp.db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [stored.value, projectId]),
    ).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
    expect(activeManifest(harness, projectId)).toBe(before);
  });

  it("Limit: a raw INSERT of a grant row is not refused by the schema; the run it names still is not confirmed", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-raw-grant");
    const { run, proposed, candidate } = await readyContractChange(harness, projectId);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const plan = harness.cp.artifacts.latest(run.runId, "PLAN")!;
    const packet = harness.cp.artifacts.latestForSnapshot(run.runId, "PRODUCTION_READY_PACKET", candidate)!;
    harness.cp.db.run(
      `INSERT INTO manifest_activation_grants
         (grant_id, run_id, project_id, run_kind, manifest_digest, from_manifest_digest, plan_digest,
          candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
          ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest)
       VALUES (?, ?, ?, 'CONTRACT_CHANGE', ?, ?, ?, ?, ?, ?, 'actor:forged', ?, ?, ?, ?, ?)`,
      ["mag_forged", run.runId, projectId, manifestDigest(proposed), run.baseDigest, plan.digest, candidate, packet.digest,
        ceo.assignmentId, ceo.sessionId, ceo.sessionIncarnation, ceo.bindingGeneration, harness.clock.nowIso(), "sha256:forged"],
    );
    await runDaemon(harness);
    // The run is not in a finalization state, so nothing consumes the row; its own CONFIRM now
    // conflicts with it, which is the denial a raw writer can cause (the Limit).
    expect(stateOf(harness, run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
    expect((await confirm(harness, run.runId, candidate)).allowed).toBe(false);
  });
});

describe("in-flight runs and existing CONTRACT_CHANGE runs", () => {
  it("ruling 1: an ordinary run pinned to M0 keeps its pin and its CONFIRM is not refused as superseded; a run dispatched after pins M1", async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness, { projectId: "cc-inflight" });
    const m0 = harness.cp.runs.require(driven.runId).pinnedManifestDigest!;
    const change = await readyContractChange(harness, driven.projectId);
    expect((await confirm(harness, change.run.runId, change.candidate)).allowed).toBe(true);
    await runDaemon(harness);
    const m1 = manifestDigest(change.proposed);
    expect(activeManifest(harness, driven.projectId)).toBe(m1);

    expect(harness.cp.runs.require(driven.runId).pinnedManifestDigest).toBe(m0);
    const verification = harness.cp.artifacts.latestForSnapshot<{ results: Array<{ commandId: string }> }>(driven.runId, "VERIFICATION", driven.candidateSnapshotDigest)!;
    expect(verification.content.results.map((result) => result.commandId)).toEqual(["verify"]);
    await harness.cp.continuity.evaluate("in-flight packet");
    harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "candidate verified",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    const decided = await confirm(harness, driven.runId, driven.candidateSnapshotDigest);
    expect(decided.reasonCode).not.toBe("MANIFEST_PIN_SUPERSEDED");

    const next = await dispatchRun(harness, driven.projectId, RunKind.STANDARD_WORK, [
      { repositoryId: driven.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
    ]);
    expect(next.baseDigest).toBe(m1);
  });

  it("ruling 8: a CONTRACT_CHANGE run confirmed without a grant is listed by doctor, not moved, and its artifacts are kept", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-legacy");
    const { run, candidate } = await readyContractChange(harness, projectId);
    // What a run confirmed before v44 looks like: CEO_APPROVED, with no grant.
    expect(harness.cp.runs.transition(run.runId, RunState.CEO_APPROVED, "confirmed before v44", { candidateSnapshotDigest: candidate }).allowed).toBe(true);
    const artifactsBefore = harness.cp.artifacts.list(run.runId).length;
    await runDaemon(harness);
    const report = await harness.cp.doctor.run("run", run.runId);
    const finding = report.findings.find((entry) => entry.code === "CONTRACT_CHANGE_RUN_WITHOUT_GRANT");
    expect(finding).toMatchObject({ scope: `run:${run.runId}`, blocking: false, observedEvidence: { cause: "CONFIRMED_WITHOUT_GRANT" } });
    expect(stateOf(harness, run.runId)).toBe(RunState.CEO_APPROVED);
    expect(harness.cp.artifacts.list(run.runId).length).toBe(artifactsBefore);
    expect(activeManifest(harness, projectId)).toBe(run.baseDigest);
  });
});

/** One line-delimited MCP connection to a daemon socket, kept open between requests. */
const openMcp = (socketPath: string, credential: { sessionId: string; sessionSecret: string }) => {
  const socket: Socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  let closed = false;
  const waiters: Array<() => void> = [];
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on("close", () => {
    closed = true;
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on("error", () => undefined);
  const lines = (): Record<string, unknown>[] =>
    buffer.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  const send = (line: unknown): void => {
    socket.write(`${JSON.stringify(line)}\n`);
  };
  const response = async (id: number): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + 5_000;
    while (!lines().some((line) => line["id"] === id)) {
      if (closed || Date.now() > deadline) return null;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return lines().find((line) => line["id"] === id) ?? null;
  };
  send({ token: "witness-mcp-token", ...credential });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cc-witness", version: "1" } } });
  return {
    initialized: async () => {
      const answer = await response(1);
      if (answer) send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      return answer;
    },
    call: async (id: number, args: Record<string, unknown>) => {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ceo_decision_submit", arguments: args } });
      const answer = await response(id);
      const result = answer?.["result"] as { structuredContent?: Record<string, unknown> } | undefined;
      return result?.structuredContent ?? null;
    },
    close: () => socket.destroy(),
  };
};

describe("ruling 9: a CONTRACT_CHANGE CONFIRM and another ceoSessionId", () => {
  it("9(a) hermes.mcp.sock: the bound CEO naming another session gets no grant; naming itself gets one bound to its session", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-socket");
    const { run, candidate } = await readyContractChange(harness, projectId);
    const ceo = switchToAnotherCeo(harness, "wire-ceo");
    const other = harness.cp.sessions.create({ provider: "scripted", model: "other" });
    harness.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "other");
    await harness.cp.continuity.evaluate("socket confirm");
    const listeners = await startDaemonMcpListeners(harness.cp, tempDir("acp-cc-sock-"), "witness-mcp-token", {
      finalizeApprovedRun: async () => undefined,
    });
    try {
      const connection = openMcp(listeners.socketPaths[0]!, ceo);
      expect(await connection.initialized()).not.toBeNull();
      const args = (key: string, ceoSessionId: string) => ({
        idempotencyKey: key, runId: run.runId, decision: "CONFIRM", candidateSnapshotDigest: candidate, ceoSessionId, rationale: "socket witness",
      });
      for (const [index, named] of [other.sessionId, run.ownerSessionId].entries()) {
        const refused = await connection.call(10 + index, args(`cc-other-${index}`, named));
        expect(refused).toMatchObject({ ok: false });
      }
      expect(grantRow(harness, run.runId)).toBeNull();
      expect(stateOf(harness, run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);

      const confirmed = await connection.call(20, args("cc-self", ceo.sessionId));
      expect(confirmed).toMatchObject({ ok: true, value: { state: RunState.CEO_APPROVED } });
      expect(grantRow(harness, run.runId)!.ceo_session_id).toBe(ceo.sessionId);
      connection.close();
    } finally {
      await listeners.close();
    }
  });

  it("9(a) a door whose authenticated session is not the one the call names issues no grant", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "cc-ingress");
    const { run, candidate } = await readyContractChange(harness, projectId);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    await harness.cp.continuity.evaluate("ingress confirm");
    const refused = await createHermesMcpPort(harness.cp).submitCeoDecision({
      runId: run.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: candidate,
      ceoSessionId: ceo.sessionId,
      rationale: "a door that did not pin the CEO binding",
      ingress: { sessionId: run.ownerSessionId, sessionIncarnation: ceo.sessionIncarnation },
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: "MANIFEST_ACTIVATION_AUTHORITY_STALE" });
    expect(stateOf(harness, run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(grantRow(harness, run.runId)).toBeNull();
  });
});

/**
 * A dispatched CONTRACT_CHANGE run on the fixture repository: its PLAN carries M1, its one task's worker
 * commits the passing change and the CI workflow M1 approves (`workflow`), and its candidate is reviewed
 * and published. GitHub's fake holds `dev` at the base and the work branch at the candidate, and merges
 * to the candidate head.
 */
const PROJECT_WORKFLOW_PATH = ".github/workflows/project.yml";
const PROJECT_WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";

const repositoryContractChange = async (h: Harness, github: FakeGitHub, projectId: string, workflow: string = WORKFLOW) => {
  // The base already declares a trusted project CI workflow: an ordinary merge needs a post-merge check.
  writeFiles(h.repoPath, { [PROJECT_WORKFLOW_PATH]: PROJECT_WORKFLOW });
  commitAll(h.repoPath, "add the trusted project CI workflow");
  const registered = await registerFixtureProject(h, projectId, {
    ciWorkflows: [{ path: PROJECT_WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(PROJECT_WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
  });
  const run = await dispatchRun(h, registered.projectId, RunKind.CONTRACT_CHANGE, [
    { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
  ]);
  const m1 = stricter(run.base);
  carryContractChange(h, run.runId, m1);
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "workflow", title: "add the CI workflow", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    workerSessionId: bindWorker(h, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: registered.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const workBranch = `feature/F1-${projectId}`;
  applyPassingChange(h.repoPath, workBranch);
  writeFiles(h.repoPath, { [WORKFLOW_PATH]: workflow });
  const head = commitAll(h.repoPath, "add the CI workflow the contract change approves");
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  await h.cp.continuity.evaluate("repository contract change");
  const claimed = h.cp.claims.acquire({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    ownerRoleKey: h.cp.runs.require(run.runId).ownerRoleKey!,
    repositoryIdentity: registered.identity,
    branch: workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  h.scripted.script({
    match: /# Candidate review/,
    text: reviewerPass([`${registered.identity}:src/app.js`, `${registered.identity}:${WORKFLOW_PATH}`, `${run.projectId}:#manifest/${manifestDigest(m1)}`]),
  });
  const submitted = await h.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    resultSummary: "the CI workflow and the manifest that requires it",
    recommendation: "activate the contract change",
    residualRisk: [],
  });
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  expect(stateOf(h, run.runId)).toBe(RunState.READY_FOR_CEO_REVIEW);
  const candidate = h.cp.runs.currentCandidate(run.runId)!;
  const snapshot = h.cp.artifacts.latestForSnapshot<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT", candidate)!.content;
  const repository = snapshot.repositories[0]!;
  github.setBranch("dev", repository.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(workBranch, repository.candidateHead);
  github.nextMergeSha = repository.candidateHead;
  github.onMerge = ({ mergeSha }) => github.setTrustedPostMergeCheck(mergeSha, "project-ci", PROJECT_WORKFLOW_PATH);
  return { registered, run, m1, candidate, candidateHead: repository.candidateHead };
};

/** GitHub's merged pull keeps its base snapshot; the target ref is reread separately. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const answer = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !answer || typeof answer !== "object") return answer;
    const merged = answer as { merged?: unknown; sha?: unknown };
    const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === number);
    if (merged.merged !== true || typeof merged.sha !== "string" || !pull) return answer;
    pull.merge_commit_sha = merged.sha;
    github.setBranch(pull.base.ref, merged.sha);
    return answer;
  };
};

describe("with a repository: merge first, then activate", () => {
  it("W18 E2E: merge, exact post-merge verification, the workflow compared at the merge commit, then activation and COMPLETED together", async () => {
    const { github, harness } = githubHarness();
    reflectMergedBase(github);
    const change = await repositoryContractChange(harness, github, "cc-repo-e2e");
    expect((await confirm(harness, change.run.runId, change.candidate)).allowed).toBe(true);
    await runDaemon(harness);
    expect(github.mergeCount).toBe(1);
    expect(stateOf(harness, change.run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, change.registered.projectId)).toBe(manifestDigest(change.m1));
    expect(activations(harness)[0]!.evidence["workflows"]).toEqual([
      expect.objectContaining({ path: PROJECT_WORKFLOW_PATH, evidence: "REUSED" }),
      expect.objectContaining({ path: WORKFLOW_PATH, evidence: "READ", revision: change.candidateHead, observedDigest: sha256(WORKFLOW) }),
    ]);
  });

  it("ruling 3: activation refused after the merge ends BLOCKED_POST_MERGE naming MANIFEST_ACTIVATION_REFUSED; the pointer does not move; a no-repository run recovers", async () => {
    const { github, harness } = githubHarness();
    reflectMergedBase(github);
    const change = await repositoryContractChange(harness, github, "cc-repo-blocked");
    expect((await confirm(harness, change.run.runId, change.candidate)).allowed).toBe(true);
    // The CEO role moves to another actor between the merge and the activation.
    const onMerge = github.onMerge!;
    github.onMerge = (merge) => {
      onMerge(merge);
      switchToAnotherCeo(harness, "post-merge-ceo");
    };
    await runDaemon(harness);
    expect(github.mergeCount).toBe(1);
    expect(stateOf(harness, change.run.runId)).toBe(RunState.BLOCKED_POST_MERGE);
    expect(activeManifest(harness, change.registered.projectId)).toBe(change.run.baseDigest);
    expect(grantRow(harness, change.run.runId)!.consumed_at).toBeNull();
    const blocked = harness.cp.audit.forRun(change.run.runId).find((entry) => entry.kind === "FINALIZATION_BLOCKED_POST_MERGE")!;
    expect(blocked.evidence["failureReasonCode"]).toBe("MANIFEST_ACTIVATION_REFUSED");

    // Recovery: a new CONTRACT_CHANGE run with no repositories carrying the same manifest, confirmed by
    // the CEO that now holds the role; its workflow is compared at the merged result on `dev`.
    github.onMerge = null;
    const recovery = await readyContractChange(harness, change.registered.projectId, () => change.m1);
    expect(recovery.run.baseDigest).toBe(change.run.baseDigest);
    expect((await confirm(harness, recovery.run.runId, recovery.candidate)).allowed).toBe(true);
    await runDaemon(harness, "acp-cc-recovery-");
    expect(stateOf(harness, recovery.run.runId)).toBe(RunState.COMPLETED);
    expect(activeManifest(harness, change.registered.projectId)).toBe(manifestDigest(change.m1));
    expect(activations(harness)[0]!.evidence["workflows"]).toEqual([
      expect.objectContaining({ path: PROJECT_WORKFLOW_PATH, evidence: "REUSED" }),
      expect.objectContaining({ path: WORKFLOW_PATH, evidence: "READ", revision: change.candidateHead, observedDigest: sha256(WORKFLOW) }),
    ]);
    expect(stateOf(harness, change.run.runId)).toBe(RunState.BLOCKED_POST_MERGE);
  });

  it("ruling 6 with a repository: a candidate whose workflow is not the approved one is refused before any merge", async () => {
    const { github, harness } = githubHarness();
    reflectMergedBase(github);
    const tampered = `${WORKFLOW}# candidate bytes differ\n`;
    const change = await repositoryContractChange(harness, github, "cc-repo-tampered", tampered);
    expect((await confirm(harness, change.run.runId, change.candidate)).allowed).toBe(true);
    await runDaemon(harness);
    expect(github.mergeCount).toBe(0);
    expect(stateOf(harness, change.run.runId)).toBe(RunState.CEO_APPROVED);
    expect(activeManifest(harness, change.registered.projectId)).toBe(change.run.baseDigest);
    expect(lastFailure(harness, change.run.runId)).toMatchObject({
      reasonCode: "MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED",
      evidence: { revision: change.candidateHead, observedDigest: sha256(tampered) },
    });
  });
});
