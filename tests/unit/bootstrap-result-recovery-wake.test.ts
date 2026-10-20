import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { ArtifactKind, Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  BOOTSTRAP_RESULT_RECOVERY_WAKE,
  resultRecoveryTriggerId,
  resultRecoveryTriggerKind,
} from "../../src/runtime/provisioned-session-runtime.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { passBootstrapPlanReviews, resultState } from "../helpers/bootstrap-result.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { scriptBootstrapOwner, type ScriptedBootstrapOwner } from "../helpers/scripted-bootstrap-owner.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * The guarded bootstrap result recovery wake (`Daemon.wakeBootstrapResultRecovery`): an ACTIVE
 * project-less bootstrap run with a PLAN, no result submitted for that PLAN and no review in progress,
 * whose exact pinned owner is READY, driven, credentialed and idle, is woken once per (run, owner
 * generation, PLAN digest). Every row drives the real sockets, launch channel, in-band wake, worker
 * candidate pipeline; only providers are scripted. No worker is staffed and no receipt is written.
 */

const markers = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.audit.byKind(BOOTSTRAP_RESULT_RECOVERY_WAKE)
    .filter((row) => row.runId === runId)
    .map((row) => row.evidence);

const planDigestOf = (f: BootstrapRuntimeFixture, runId: string): string => f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest;

const ticks = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A run whose owner planned on its RUN_DISPATCH, acknowledged it, submitted no result and ended its turn. */
const planned = async (f: BootstrapRuntimeFixture, onResult: ScriptedBootstrapOwner["onResult"]) => {
  // A revision is answered by its own directive and witness; these rows are about the result stage alone.
  const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onResult, onRevision: "ignore" });
  const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
  // The dispatch turn plans (and may submit a result, which runs a review): waited for, however long it takes under load.
  await f.awaitFinishedTurns(ownerSessionId, 1);
  await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
  expect(owner.results).toEqual([]);
  expect(resultState(f, runId)).toEqual({ state: RunState.ACTIVE, candidate: null, attempts: [] });
  return { owner, runId, ownerSessionId, roleKey, planDigest: planDigestOf(f, runId) };
};

const submitResult = (f: BootstrapRuntimeFixture, runId: string, ownerSessionId: string) =>
  f.cto(ownerSessionId, "result_submit", { runId, resultSummary: "the planned bootstrap outputs", recommendation: "create the repository" });

const frozenCandidates = (f: BootstrapRuntimeFixture, runId: string): number =>
  f.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === runId).length;

const startDaemon = async (f: BootstrapRuntimeFixture, name: string): Promise<Daemon> => {
  f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.harness.cp, { stateDir: tempDir(`acp-brr-${name}-`), watchdogIntervalMs: 50 });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  return daemon;
};

/** What a daemon process that starts again no longer has: the runtime's memory of its turns. Its credential is delivered again. */
const forgetRuntimeMemory = (f: BootstrapRuntimeFixture, sessionId: string): void => {
  const credential = f.claude.credentials.get(sessionId);
  if (!credential) throw new Error("the session's runtime never took its credential");
  const epoch = f.harness.cp.sessions.require(sessionId).credentialEpoch;
  f.harness.cp.sessionRuntime.release(sessionId);
  expect(f.harness.cp.sessionRuntime.adopt(sessionId, Role.BOOTSTRAP_CTO, credential.sessionSecret, epoch).allowed).toBe(true);
};

const barrier = () => {
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, enter: () => { entered = true; }, entered: () => entered, release: () => release() };
};

describe("the result recovery wake: once per (run, owner generation, PLAN digest)", () => {
  it("wakes the stalled owner once with a trigger that says why; a second pass wakes nothing, and nothing follows up an owner that does not answer", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, ownerSessionId, roleKey, planDigest } = await planned(f, "ignore");
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [{ runId, roleKey, bindingGeneration: 1, planDigest }] });
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      expect(owner.prompts.at(-1)).toContain(`The control plane woke you for: ${resultRecoveryTriggerKind(runId)}.`);
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      await ticks(50);
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
      const triggerId = resultRecoveryTriggerId(runId, 1, planDigest);
      expect(markers(f, runId)).toEqual([{ bindingGeneration: 1, planDigest, triggerId }]);
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{ id: triggerId, kind: resultRecoveryTriggerKind(runId) }]))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_TURN_DUPLICATE });
      // The no-PLAN stage leaves a planned run alone.
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      expect(resultState(f, runId)).toEqual({ state: RunState.ACTIVE, candidate: null, attempts: [] });
    });
  });

  it("a run whose result was submitted is never woken: at CEO review, or returned by a REVISE verdict on the same PLAN; and no second result is submitted", async () => {
    await withBootstrapRuntime(async (f) => {
      passBootstrapPlanReviews(f, { verdict: "REVISE" });
      const { runId, ownerSessionId } = await planned(f, "ignore");
      expect(await submitResult(f, runId, ownerSessionId)).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
      // The REVISION_REQUEST reaches the owner in band; once that turn has ended the run is ACTIVE with a reviewed result.
      await vi.waitFor(() => expect(f.harness.cp.outbox.listByRun(runId)
        .filter((row) => row.kind === MessageKind.REVISION_REQUEST).map((row) => row.status)).toEqual(["ACKED"]));
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(resultState(f, runId)).toMatchObject({ state: RunState.ACTIVE, attempts: ["RELEASED"] });
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(markers(f, runId)).toEqual([]);
      expect(frozenCandidates(f, runId)).toBe(1);
    });
    await withBootstrapRuntime(async (f) => {
      passBootstrapPlanReviews(f);
      const { runId, ownerSessionId } = await planned(f, "ignore");
      expect(await submitResult(f, runId, ownerSessionId)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      const turns = f.finishedTurns(ownerSessionId);
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      const daemon = await startDaemon(f, "reviewed");
      try {
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(turns);
      expect(markers(f, runId)).toEqual([]);
      expect(frozenCandidates(f, runId)).toBe(1);
    });
  });

  it("a run whose review is in progress is not woken", async () => {
    await withBootstrapRuntime(async (f) => {
      const review = barrier();
      passBootstrapPlanReviews(f, { hold: review.gate.then(() => undefined) });
      const { runId, ownerSessionId } = await planned(f, "ignore");
      const submitting = submitResult(f, runId, ownerSessionId);
      await vi.waitFor(() => expect(resultState(f, runId).attempts).toEqual(["RUNNING"]));
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      review.release();
      expect(await submitting).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(markers(f, runId)).toEqual([]);
    });
  });

  it("an owner whose session is not READY, whose binding was revoked, or superseded by a later generation, is not woken", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await planned(f, "ignore");
      expect(f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.DRAINING, "test: draining").allowed).toBe(true);
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.READY, "test: ready again").allowed).toBe(true);
      expect(f.daemon.wakeBootstrapResultRecovery().woken).toHaveLength(1);
      expect(markers(f, runId)).toHaveLength(1);
    });
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await planned(f, "ignore");
      const session = f.harness.cp.sessions.require(ownerSessionId);
      f.harness.cp.sessionRuntime.release(ownerSessionId);
      await f.daemon.reconcileContinuity("first tick after a restart");
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      forgetRuntimeMemory(f, ownerSessionId);
      expect(f.harness.cp.runs.transition(runId, RunState.ACTIVE, "test: active with a revoked owner").allowed).toBe(true);
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      const renewed = f.harness.cp.bindings.renewSameSession({
        roleKey,
        expectedGeneration: 1,
        sessionId: ownerSessionId,
        sessionIncarnation: session.incarnation,
        reason: "test: superseded",
      });
      expect(renewed).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.ACTIVE, ownerBindingGeneration: 1 });
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(markers(f, runId)).toEqual([]);
      expect(f.finishedTurns(ownerSessionId)).toBe(1);
    });
  });

  it("a second daemon start for the same tuple wakes nothing, though the runtime's own memory of the wake is gone", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, planDigest } = await planned(f, "ignore");
      const first = await startDaemon(f, "first");
      try {
        await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2), { timeout: 10_000, interval: 25 });
        await ticks(200);
      } finally {
        await first.stop();
      }
      forgetRuntimeMemory(f, ownerSessionId);
      const second = await startDaemon(f, "second");
      try {
        await ticks(400);
      } finally {
        await second.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
      expect(markers(f, runId)).toHaveLength(1);
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{
        id: resultRecoveryTriggerId(runId, 1, planDigest),
        kind: resultRecoveryTriggerKind(runId),
      }])).toMatchObject({ allowed: true, value: "STARTED" });
    });
  });
});

/** Holds the next launch preparation — between the wake that admitted a turn and its provider call — until released. */
const holdLaunchPreparation = (f: BootstrapRuntimeFixture) => {
  const held = barrier();
  const prepare = f.launch.prepare.bind(f.launch);
  vi.spyOn(f.launch, "prepare").mockImplementationOnce(async () => {
    held.enter();
    await held.gate;
    return prepare();
  });
  return held;
};

const turnsRefused = (f: BootstrapRuntimeFixture, sessionId: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_TURN_REFUSED' AND session_id = ?`,
    [sessionId],
  )?.n ?? 0;

describe("the result recovery wake's eligibility is asked again immediately before the provider call", () => {
  it("(a) a result the owner submitted while launch preparation awaited suppresses the recovery turn; no second result is submitted", async () => {
    await withBootstrapRuntime(async (f) => {
      const review = barrier();
      passBootstrapPlanReviews(f, { hold: review.gate.then(() => undefined) });
      const { owner, runId, ownerSessionId } = await planned(f, "recovery-only");
      const providerTurns = f.claude.turns.length;
      const held = holdLaunchPreparation(f);
      expect(f.daemon.wakeBootstrapResultRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(held.entered()).toBe(true));
      const submitting = submitResult(f, runId, ownerSessionId);
      await vi.waitFor(() => expect(resultState(f, runId).attempts).toEqual(["RUNNING"]));
      held.release();
      await vi.waitFor(() => expect(turnsRefused(f, ownerSessionId)).toBe(1));
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.claude.turns.length).toBe(providerTurns);
      review.release();
      expect(await submitting).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(owner.results).toEqual([]);
      expect(frozenCandidates(f, runId)).toBe(1);
      expect(markers(f, runId)).toHaveLength(1);
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
    });
  });

  it("(b) an owner whose run was held and whose binding was revoked while launch preparation awaited is never contacted; the wake stays spent", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, ownerSessionId, roleKey } = await planned(f, "recovery-only");
      const cp = f.harness.cp;
      const providerTurns = f.claude.turns.length;
      const held = holdLaunchPreparation(f);
      expect(f.daemon.wakeBootstrapResultRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(held.entered()).toBe(true));
      expect(cp.runs.transition(runId, RunState.BLOCKED, "test: held while the wake prepares").allowed).toBe(true);
      expect(cp.bindings.revoke(roleKey, "test: revoked while the wake prepares", { allowBlockedRuns: true }).allowed).toBe(true);
      held.release();
      await vi.waitFor(() => expect(turnsRefused(f, ownerSessionId)).toBe(1));
      await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.claude.turns.length).toBe(providerTurns);
      expect(owner.results).toEqual([]);
      expect(markers(f, runId)).toHaveLength(1);
    });
  });
});

describe("the prompt: the bootstrap result directive and the result recovery wake's own line", () => {
  it("every work prompt carries the generic result and revision directives, with no worker or receipt step, and only a result recovery wake's prompt carries its line, the same bytes for every run", async () => {
    await withBootstrapRuntime(async (f) => {
      const first = await planned(f, "ignore");
      const second = await planned(f, "ignore");
      expect(f.daemon.wakeBootstrapResultRecovery().woken).toHaveLength(2);
      await vi.waitFor(() => expect(f.finishedTurns(first.ownerSessionId) + f.finishedTurns(second.ownerSessionId)).toBe(4));
      const prompts = f.claude.turns.filter((turn) => !/nonce set to/.test(turn.prompt)).map((turn) => turn.prompt);
      expect(prompts).toHaveLength(4);
      const lines = (prompt: string) => prompt.split("\n");
      const directive = (prompt: string) => lines(prompt).find((line) => line.startsWith("For a run whose contract_get returned a bootstrapPlanGuide"));
      const revisionLine = (prompt: string) => lines(prompt).find((line) => line.startsWith("A REVISION_REQUEST for a run whose contract_get returned"));
      for (const prompt of prompts) {
        expect(directive(prompt)).toContain("mcp__acp-cto__result_submit");
        expect(revisionLine(prompt)).toContain("mcp__acp-cto__plan_submit");
        expect(prompt).not.toContain("task_worker_provision");
        expect(prompt).not.toContain("task_receipt_submit");
        expect(prompt).toContain("acknowledge each one with mcp__acp-cto__run_ack");
      }
      expect(new Set(prompts.map(directive)).size).toBe(1);
      expect(new Set(prompts.map(revisionLine)).size).toBe(1);
      for (const runId of [first.runId, second.runId]) expect(directive(prompts[0]!)).not.toContain(runId);
      const recoveryLine = (prompt: string) =>
        lines(prompt).find((line) => line.startsWith('A wake for "result recovery: run <runId> has a PLAN and no result"'));
      const recoveries = prompts.filter((prompt) => recoveryLine(prompt) !== undefined);
      expect(recoveries).toHaveLength(2);
      expect(new Set(recoveries.map(recoveryLine)).size).toBe(1);
      expect(recoveryLine(recoveries[0]!)).toContain("mcp__acp-cto__result_submit");
      for (const runId of [first.runId, second.runId]) expect(recoveryLine(recoveries[0]!)).not.toContain(runId);
    });
  });
});
