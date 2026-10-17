import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTINUITY_COVERAGE_REVOCATION_REASON,
  CONTINUITY_RUNTIME_CREDENTIAL_LOST_REASON,
} from "../../src/continuity/continuity-kernel.ts";
import { ArtifactKind, ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { ownerDecisionReceipt, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * A daemon restart drops the credential of a provisioned BOOTSTRAP_CTO. The first sweep revokes the
 * binding and, for a run waiting on the CEO, moves it READY_FOR_CEO_REVIEW → AWAITING_HUMAN; the next
 * sweep recovers the same session. Continuity placed that wait, so when it gives the role back on the
 * owner the run is pinned to, it takes the wait back: AWAITING_HUMAN → ACTIVE → READY_FOR_CEO_REVIEW
 * in one transaction, the same candidate and packet, nothing dispatched. A wait anyone else placed or
 * kept, or one something moved since, is left exactly as it was.
 */

const CONTRACT: TaskContract = {
  goal: "bootstrap a new project",
  why: "the owner asked for a repository that does not exist yet",
  scope: [],
  nonGoals: [],
  acceptance: ["the project exists and its CTO is bound"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

interface ReviewReady {
  runId: string;
  ownerSessionId: string;
  roleKey: string;
  candidate: string;
  packetId: string;
}

/** A project-less bootstrap run at CEO review the way production gets there: plan, review, result, packet. */
const reviewReady = async (f: BootstrapRuntimeFixture, contract: Partial<TaskContract> = {}): Promise<ReviewReady> => {
  const created = await f.hermes("run_create", {
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: { ...CONTRACT, ...contract },
  });
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  const runId = (created["value"] as { runId: string }).runId;
  const dispatched = await f.hermes("run_dispatch", { runId });
  expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ ok: true });
  const ownerSessionId = f.harness.cp.runs.require(runId).ownerSessionId!;
  await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
  const planned = await f.cto(ownerSessionId, "plan_submit", {
    runId,
    plan: bootstrapPlan(cleanTreeManifest("review-hold")),
    tasks: [{ key: "bootstrap", title: "bootstrap the repository", category: "implementation" }],
  });
  expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true });
  f.harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.harness, runId)) });
  const submitted = await f.cto(ownerSessionId, "result_submit", {
    runId,
    resultSummary: "the planned bootstrap outputs",
    recommendation: "create the repository",
  });
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
  expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  const candidate = f.harness.cp.runs.currentCandidate(runId)!;
  const packet = f.harness.cp.artifacts.latestForSnapshot(runId, ArtifactKind.PRODUCTION_READY_PACKET, candidate);
  expect(packet).not.toBeNull();
  expect(f.harness.cp.ceo.humanGateStatus(runId).satisfied).toBe((contract.humanGate ?? []).length === 0);
  return { runId, ownerSessionId, roleKey: roleKeyFor(Role.BOOTSTRAP_CTO, { runId }), candidate, packetId: packet!.artifactId };
};

/** What must not move when continuity takes back its own wait. */
const sideEffects = (f: BootstrapRuntimeFixture, runId: string) => ({
  dispatches: f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "RUN_DISPATCH").length,
  notifications: f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "CEO_NOTIFICATION").length,
  packets: f.harness.cp.artifacts.list(runId, ArtifactKind.PRODUCTION_READY_PACKET).length,
  promotions: f.harness.cp.audit.forRun(runId).filter((entry) => entry.kind === "CANDIDATE_PROMOTED").length,
  applications: f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bootstrap_applications WHERE run_id = ?`, [runId])?.n ?? 0,
});

const transitions = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.audit.forRun(runId).filter((entry) => entry.kind === "RUN_TRANSITION").map((entry) => entry.evidence);

/** The restart's first sweep: the credential is gone, the run is paused and the binding revoked. */
const restart = async (f: BootstrapRuntimeFixture, ready: ReviewReady) => {
  f.harness.cp.sessionRuntime.release(ready.ownerSessionId);
  return f.daemon.reconcileContinuity("first tick after a restart");
};

/** Continuity's pause at CEO review as a reconcile pass asks the run engine for it. */
interface PauseCall {
  reason: string;
  evidence: Record<string, unknown>;
}

/**
 * Runs `pass` with each continuity pause at CEO review the reconcile writes rewritten by `pause`, and
 * each deferred revocation's evidence by `deferral`: the pass is the real one, in its real order, and
 * only what the rewrite names differs.
 */
const rewritingPass = async <T>(
  f: BootstrapRuntimeFixture,
  rewrite: { pause?: (call: PauseCall) => PauseCall; deferral?: (evidence: Record<string, unknown>) => Record<string, unknown> },
  pass: () => Promise<T>,
): Promise<T> => {
  const runs = f.harness.cp.runs;
  const audit = f.harness.cp.audit;
  const transition = runs.transition.bind(runs);
  const record = audit.record.bind(audit);
  const spies = [
    vi.spyOn(runs, "transition").mockImplementation((runId, to, reason, evidence = {}, authority) => {
      if (!rewrite.pause || to !== RunState.AWAITING_HUMAN || evidence["continuityAction"] !== "PAUSE_NEW_WORK") {
        return transition(runId, to, reason, evidence, authority);
      }
      const rewritten = rewrite.pause({ reason, evidence });
      return transition(runId, to, rewritten.reason, rewritten.evidence, authority);
    }),
    vi.spyOn(audit, "record").mockImplementation((entry) =>
      rewrite.deferral && entry.kind === "CONTINUITY_REVOKE_DEFERRED"
        ? record({ ...entry, evidence: rewrite.deferral({ ...entry.evidence }) })
        : record(entry),
    ),
  ];
  try {
    return await pass();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

/**
 * The two rows the code before this change wrote differently in this pass: the pause carried only
 * `roleKey` (which the audit log stores redacted) and `continuityAction` — no `continuityHold`, no
 * candidate, no owner — and a deferred revocation carried only its reason, no generation.
 */
const OLD_CODE = {
  pause: ({ reason, evidence }: PauseCall): PauseCall => ({
    reason,
    evidence: { roleKey: evidence["roleKey"], continuityAction: evidence["continuityAction"] },
  }),
  deferral: ({ reason }: Record<string, unknown>) => ({ reason }),
};

/** The restart's first sweep, as the code before this change ran it: a legacy pause, then the revocation. */
const legacyRestart = (f: BootstrapRuntimeFixture, ready: ReviewReady) => rewritingPass(f, OLD_CODE, () => restart(f, ready));

/** The restart's first sweep with only the new-shape pause's evidence edited. */
const restartWithPause = (f: BootstrapRuntimeFixture, ready: ReviewReady, edit: (evidence: Record<string, unknown>) => Record<string, unknown>) =>
  rewritingPass(f, { pause: ({ reason, evidence }) => ({ reason, evidence: edit({ ...evidence }) }) }, () => restart(f, ready));

/**
 * A legacy pause written by hand, for a role or reason the fixture's reconcile cannot lose: the old
 * shape, then (with `endPass`) the CONTINUITY_RECONCILED its pass would have written naming the run.
 */
const legacyPauseFor = (f: BootstrapRuntimeFixture, ready: ReviewReady, roleKey: string, reason = CONTINUITY_RUNTIME_CREDENTIAL_LOST_REASON) => {
  const paused = f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, reason, {
    roleKey,
    continuityAction: "PAUSE_NEW_WORK",
  });
  expect(paused.allowed).toBe(true);
};

const endPass = (f: BootstrapRuntimeFixture, ready: ReviewReady, roleKey: string) => {
  expect(f.harness.cp.audit.record({
    kind: "CONTINUITY_RECONCILED",
    evidence: {
      reason: "the old daemon's pass",
      outcome: "PARTIAL_COVERAGE",
      action: "PAUSE_NEW_WORK",
      mode: "DEGRADED",
      reassigned: [],
      pausedRuns: [{ runId: ready.runId, roleKey, reasonCode: "COVERAGE_INCOMPLETE" }],
      unresolved: [],
      restoration: { restored: [], deferred: [] },
      restorationPending: [],
    },
  }).allowed).toBe(true);
};

/** The next sweeps: restore recovers the same session at the next generation. */
const recover = async (f: BootstrapRuntimeFixture, ready: ReviewReady, generation = 2) => {
  for (let tick = 0; tick < 2 && f.harness.cp.bindings.active(ready.roleKey) === null; tick += 1) {
    await f.daemon.reconcileContinuity(`recovery tick ${tick}`);
  }
  expect(f.harness.cp.bindings.active(ready.roleKey)).toMatchObject({ bindingGeneration: generation, sessionId: ready.ownerSessionId });
};

/**
 * The recovery the code before this change ran: the owner renewed on its own session at the next
 * generation, the run left waiting and nothing written to it but RUN_OWNER_RENEWED. That code never
 * asked the human gate; this stand-in makes the gate read unsatisfied for these sweeps only.
 */
const oldRecovery = async (f: BootstrapRuntimeFixture, ready: ReviewReady, generation: number) => {
  const gate = vi.spyOn(f.harness.cp.ceo, "humanGateStatus").mockReturnValue({ required: true, items: [], satisfied: false });
  try {
    await recover(f, ready, generation);
  } finally {
    gate.mockRestore();
  }
};

const expectReleased = (f: BootstrapRuntimeFixture, ready: ReviewReady, before: ReturnType<typeof sideEffects>, generation = 2) => {
  expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({
    state: RunState.READY_FOR_CEO_REVIEW,
    ownerSessionId: ready.ownerSessionId,
    ownerBindingGeneration: generation,
    continuityHoldRoleKey: null,
  });
  expect(f.harness.cp.runs.currentCandidate(ready.runId)).toBe(ready.candidate);
  expect(f.harness.cp.artifacts.latestForSnapshot(ready.runId, ArtifactKind.PRODUCTION_READY_PACKET, ready.candidate)?.artifactId)
    .toBe(ready.packetId);
  expect(sideEffects(f, ready.runId)).toEqual(before);
  expect(transitions(f, ready.runId).slice(-2)).toEqual([
    expect.objectContaining({ from: RunState.AWAITING_HUMAN, to: RunState.ACTIVE, continuityRelease: ready.roleKey, candidateSnapshotDigest: ready.candidate }),
    expect.objectContaining({ from: RunState.ACTIVE, to: RunState.READY_FOR_CEO_REVIEW, continuityRelease: ready.roleKey, candidateSnapshotDigest: ready.candidate }),
  ]);
};

const expectKept = (f: BootstrapRuntimeFixture, ready: ReviewReady, transitionsBefore: number) => {
  expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({ state: RunState.AWAITING_HUMAN, ownerBindingGeneration: 2 });
  expect(transitions(f, ready.runId)).toHaveLength(transitionsBefore);
  expect(f.harness.cp.outbox.listByRun(ready.runId).filter((message) => message.kind === "RUN_DISPATCH").map((message) => message.bindingGeneration))
    .toEqual([1]);
};

describe("a restart returns a run continuity paused at CEO review to CEO review", () => {
  it("revoke for credential loss, recover the same session: READY_FOR_CEO_REVIEW, same candidate and packet, no RUN_DISPATCH", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const before = sideEffects(f, ready.runId);
      const first = await restart(f, ready);
      expect(first?.pausedRuns).toContainEqual(expect.objectContaining({ runId: ready.runId, roleKey: ready.roleKey }));
      expect(f.harness.cp.bindings.active(ready.roleKey)).toBeNull();
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      // The pause now says, durably, which role it held the run for and on which candidate.
      expect(transitions(f, ready.runId).at(-1)).toMatchObject({
        from: RunState.READY_FOR_CEO_REVIEW,
        to: RunState.AWAITING_HUMAN,
        continuityAction: "PAUSE_NEW_WORK",
        continuityHold: ready.roleKey,
        candidateSnapshotDigest: ready.candidate,
      });
      await recover(f, ready);
      expectReleased(f, ready, before);
      const recovered = f.harness.cp.audit.forRun(ready.runId).filter((entry) => entry.kind === "BOOTSTRAP_CTO_RECOVERED");
      expect(recovered.at(-1)?.evidence).toMatchObject({ resumed: false, state: RunState.READY_FOR_CEO_REVIEW });
    });
  });

  it("reconcile and recovery again add nothing: no dispatch, candidate, packet or external create", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const before = sideEffects(f, ready.runId);
      await restart(f, ready);
      await recover(f, ready);
      const released = transitions(f, ready.runId).length;
      await f.daemon.reconcileContinuity("tick after the release");
      await f.daemon.reconcileContinuity("another tick");
      expect(await f.harness.cp.bootstrapCtos.recover(ready.roleKey)).toMatchObject({ allowed: false });
      const renewed = f.harness.cp.bindings.active(ready.roleKey)!;
      expect(f.harness.cp.runs.restoreRecoveredBootstrapOwner(ready.runId, renewed, 1)).toMatchObject({ allowed: false });
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, renewed)).toMatchObject({ allowed: true, value: { released: false } });
      expect(transitions(f, ready.runId)).toHaveLength(released);
      expectReleased(f, ready, before);
    });
  });

  it("the reconcile's release refuses a binding that is not the run's pinned owner, or no longer the role's active one", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const pinned = f.harness.cp.bindings.active(ready.roleKey)!;
      await restart(f, ready);
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      const count = transitions(f, ready.runId).length;
      // The pinned generation, revoked by the pause's pass.
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, pinned)).toMatchObject({ allowed: false });
      // An active binding that is not the run's owner.
      const ceo = f.harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, ceo)).toMatchObject({ allowed: false });
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });

  it("the live sequence from the reconcile, real owner gate: legacy pause at gen 1, old recovery to gen 2 keeps it, restart revokes gen 2, gen 3 releases once", async () => {
    await withBootstrapRuntime(async (f) => {
      const item = "the owner's T3 signature before the real create";
      const ready = await reviewReady(f, { humanGate: [item] });
      // The owner signs at CEO review through the owner path, as the live run's OWNER_DECISION was.
      expect(f.harness.cp.ceo.recordOwnerDecision({
        runId: ready.runId,
        item,
        approved: true,
        note: "signed",
        receipt: ownerDecisionReceipt(f.harness, ready.runId, item, true, "signed"),
      })).toMatchObject({ allowed: true });
      expect(f.harness.cp.ceo.humanGateStatus(ready.runId)).toMatchObject({ required: true, satisfied: true });
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      const before = sideEffects(f, ready.runId);

      // 1. The old code's pause at gen 1, in its own pass, which revoked gen 1.
      const first = await legacyRestart(f, ready);
      expect(first?.pausedRuns).toContainEqual(expect.objectContaining({ runId: ready.runId }));
      expect(transitions(f, ready.runId).at(-1)).toMatchObject({ roleKey: "[redacted]", continuityAction: "PAUSE_NEW_WORK" });
      expect(transitions(f, ready.runId).at(-1)).not.toHaveProperty("continuityHold");
      const paused = transitions(f, ready.runId).length;

      // 2. The old code's recovery to gen 2: a real renewal, the run left waiting, no RUN_TRANSITION.
      await oldRecovery(f, ready, 2);
      expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({ state: RunState.AWAITING_HUMAN, ownerBindingGeneration: 2 });
      expect(transitions(f, ready.runId)).toHaveLength(paused);
      expect(f.harness.cp.audit.forRun(ready.runId).filter((entry) => entry.kind === "RUN_OWNER_RENEWED").at(-1)?.evidence)
        .toMatchObject({ state: RunState.AWAITING_HUMAN, fromGeneration: 1, toGeneration: 2 });

      // 3. A restart: gen 2's credential is gone and gen 2 is revoked; the run already waits, so nothing is paused.
      const third = await restart(f, ready);
      expect(third?.pausedRuns.some((entry) => entry.runId === ready.runId)).toBe(false);
      expect(f.harness.cp.bindings.active(ready.roleKey)).toBeNull();
      expect(transitions(f, ready.runId)).toHaveLength(paused);

      // 4. Recovery at gen 3 on the same session and incarnation: the pause's generation (1) is not this one.
      await recover(f, ready, 3);
      expectReleased(f, ready, before, 3);
      expect(transitions(f, ready.runId)).toHaveLength(paused + 2);

      // 5. A repeat pass adds nothing.
      await f.daemon.reconcileContinuity("a repeat pass");
      expect(transitions(f, ready.runId)).toHaveLength(paused + 2);
      expectReleased(f, ready, before, 3);
    });
  });

  it("coverage loss defers the revocation of an owner at CEO review; coverage back on the same incumbent releases the wait", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const before = sideEffects(f, ready.runId);
      f.loseClaude();
      await f.daemon.reconcileContinuity("claude coverage lost");
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      expect(f.harness.cp.bindings.active(ready.roleKey)).toMatchObject({ bindingGeneration: 1 });
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");
      expectReleased(f, ready, before, 1);
    });
  });
});

describe("a wait continuity did not place, or that something moved since, is kept", () => {
  it("a CEO decision's AWAITING_HUMAN (OWNER_DECISION_REQUIRED) is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await f.harness.cp.continuity.evaluate("CEO decision");
      const decided = await f.hermes("ceo_decision_submit", {
        runId: ready.runId,
        decision: "OWNER_DECISION_REQUIRED",
        candidateSnapshotDigest: ready.candidate,
        ceoSessionId: f.ceoSessionId,
        rationale: "the owner decides",
      });
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, value: { state: RunState.AWAITING_HUMAN } });
      const count = transitions(f, ready.runId).length;
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("an unsatisfied human gate is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f, { humanGate: ["public release"] });
      const count = transitions(f, ready.runId).length + 1;
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a candidate invalidated after the pause is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restart(f, ready);
      expect(f.harness.cp.runs.invalidateCandidate(ready.runId, "source moved").allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a candidate changed after the pause is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restart(f, ready);
      f.harness.cp.runs.promoteCandidate(ready.runId, "sha256:another-candidate");
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a candidate promoted again after the pause is kept, although its digest is the same", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await legacyRestart(f, ready);
      f.harness.cp.runs.promoteCandidate(ready.runId, ready.candidate);
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a transition after the pause (the owner resumed it, then it waits again) is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restart(f, ready);
      expect(f.harness.cp.runs.transition(ready.runId, RunState.ACTIVE, "required owner decisions recorded").allowed).toBe(true);
      expect(f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, "waiting on a human").allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("an owner decision recorded after the pause is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restart(f, ready);
      f.harness.cp.audit.record({
        kind: "OWNER_DECISION",
        runId: ready.runId,
        actor: "cli:owner",
        evidence: { item: "x", approved: false, candidateSnapshotDigest: ready.candidate },
      });
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a legacy pause that named a different role (the CEO's, revoked in its pass) is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      legacyPauseFor(f, ready, roleKeyFor(Role.CEO), CONTINUITY_COVERAGE_REVOCATION_REASON);
      expect(f.harness.cp.bindings.revoke(roleKeyFor(Role.CEO), CONTINUITY_COVERAGE_REVOCATION_REASON, { allowBlockedRuns: true }).allowed)
        .toBe(true);
      endPass(f, ready, roleKeyFor(Role.CEO));
      const count = transitions(f, ready.runId).length;
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a new-shape pause whose continuityHold names a different role is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restartWithPause(f, ready, (evidence) => ({ ...evidence, continuityHold: roleKeyFor(Role.CEO) }));
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a new-shape pause whose candidate is not the current one is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restartWithPause(f, ready, (evidence) => ({ ...evidence, candidateSnapshotDigest: "sha256:another-candidate" }));
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a pause whose action is not continuity's PAUSE_NEW_WORK is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restartWithPause(f, ready, ({ continuityAction: _action, ...evidence }) => evidence);
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("an ambiguous chain (a second RUN_TRANSITION row between the review entry and the pause) is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      f.harness.cp.audit.record({
        kind: "RUN_TRANSITION",
        runId: ready.runId,
        evidence: {
          from: RunState.READY_FOR_CEO_REVIEW,
          to: RunState.AWAITING_HUMAN,
          continuityAction: "PAUSE_NEW_WORK",
          candidateSnapshotDigest: ready.candidate,
        },
      });
      await legacyRestart(f, ready);
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a review entry that names another candidate is kept (ambiguous chain)", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      f.harness.cp.audit.record({
        kind: "RUN_TRANSITION",
        runId: ready.runId,
        evidence: { from: RunState.ACTIVE, to: RunState.READY_FOR_CEO_REVIEW, candidateSnapshotDigest: "sha256:another-candidate" },
      });
      await legacyRestart(f, ready);
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a pause whose own row does not leave READY_FOR_CEO_REVIEW is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restartWithPause(f, ready, (evidence) => ({ ...evidence, from: RunState.ACTIVE }));
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a candidate whose packet is no longer current is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await legacyRestart(f, ready);
      f.harness.cp.db.run(
        `UPDATE run_artifacts SET superseded = 1 WHERE run_id = ? AND kind = 'PRODUCTION_READY_PACKET'`,
        [ready.runId],
      );
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a legacy pause bound to its role by a revocation record that is not continuity's is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const binding = f.harness.cp.bindings.active(ready.roleKey)!;
      // The same reason on both rows, so only its not being one of continuity's keeps the wait.
      legacyPauseFor(f, ready, ready.roleKey, "operator hold");
      f.harness.cp.audit.record({
        kind: "CONTINUITY_REVOKE_DEFERRED",
        roleKey: ready.roleKey,
        sessionId: ready.ownerSessionId,
        evidence: { reason: "operator hold", generation: binding.bindingGeneration },
      });
      endPass(f, ready, ready.roleKey);
      const count = transitions(f, ready.runId).length;
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, binding)).toMatchObject({ allowed: true, value: { released: false } });
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });
});

/**
 * A pause belongs to one loss episode: its own reconcile pass, which finished (CONTINUITY_RECONCILED
 * names the run) and revoked or deferred exactly one role for the loss the pause names. The old daemon
 * committed the pause before it revoked anything, so a pass interrupted right after the pause leaves a
 * wait no later pass's revocation or deferral can be borrowed for.
 */
describe("reviewer legacy crash gap", () => {
  it("an unfinished legacy pause for another role is not attributed to the owner's next-pass revocation", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      // Legacy daemon crashes after pausing for the CEO and before revoking it / ending its pass.
      expect(f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, CONTINUITY_COVERAGE_REVOCATION_REASON, {
        roleKey: roleKeyFor(Role.CEO),
        continuityAction: "PAUSE_NEW_WORK",
      }).allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      f.harness.clock.advance(6 * 60000);
      // A restarted daemon loses the BOOTSTRAP_CTO credential in its later pass.
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });
});

describe("reviewer deferred legacy crash gap", () => {
  it("a later deferred owner revocation also cannot identify the unfinished legacy CEO pause", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      expect(f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, CONTINUITY_COVERAGE_REVOCATION_REASON, {
        roleKey: roleKeyFor(Role.CEO),
        continuityAction: "PAUSE_NEW_WORK",
      }).allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      f.harness.clock.advance(6 * 60000);
      f.loseClaude();
      await f.daemon.reconcileContinuity("later unrelated owner coverage loss");
      expect(f.harness.cp.bindings.active(ready.roleKey)).toMatchObject({ bindingGeneration: 1 });
      expect(f.harness.cp.audit.byKind("CONTINUITY_REVOKE_DEFERRED").some((e) => e.roleKey === ready.roleKey)).toBe(true);
      f.restoreClaude();
      await f.daemon.reconcileContinuity("owner's incumbent coverage returns");
      expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({ state: RunState.AWAITING_HUMAN, ownerBindingGeneration: 1 });
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });
});

/** The daemon stops right after continuity's pause at CEO review is written, before anything else in its pass. */
const interruptedAfterPause = async (f: BootstrapRuntimeFixture, reason: string) => {
  const runs = f.harness.cp.runs;
  const transition = runs.transition.bind(runs);
  const crash = vi.spyOn(runs, "transition").mockImplementation((runId, to, why, evidence, authority) => {
    const written = transition(runId, to, why, evidence, authority);
    if (to === RunState.AWAITING_HUMAN) throw new Error("the daemon stopped right after the pause");
    return written;
  });
  try {
    await expect(f.daemon.reconcileContinuity(reason)).rejects.toThrow("the daemon stopped right after the pause");
  } finally {
    crash.mockRestore();
  }
};

describe("a pause interrupted right after it is written is released by nothing a later pass does", () => {
  it("recovery path: a later pass revokes the owner for its own loss and recovery renews it; 0 releases", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      f.harness.cp.sessionRuntime.release(ready.ownerSessionId);
      await interruptedAfterPause(f, "first tick after a restart");
      expect(transitions(f, ready.runId).at(-1)).toMatchObject({ continuityHold: ready.roleKey, to: RunState.AWAITING_HUMAN });
      expect(f.harness.cp.bindings.active(ready.roleKey)).toMatchObject({ bindingGeneration: 1 });
      const count = transitions(f, ready.runId).length;
      f.harness.clock.advance(6 * 60000);
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
      await f.daemon.reconcileContinuity("a repeat pass");
      expectKept(f, ready, count);
    });
  });

  it("incumbent path: a later pass defers the owner's revocation and coverage returns on it; 0 releases", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      f.loseClaude();
      await interruptedAfterPause(f, "claude coverage lost");
      const count = transitions(f, ready.runId).length;
      f.harness.clock.advance(6 * 60000);
      await f.daemon.reconcileContinuity("a later pass, coverage still lost");
      expect(f.harness.cp.audit.byKind("CONTINUITY_REVOKE_DEFERRED").some((e) => e.roleKey === ready.roleKey)).toBe(true);
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");
      await f.daemon.reconcileContinuity("a repeat pass");
      expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({ state: RunState.AWAITING_HUMAN, ownerBindingGeneration: 1 });
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });
});

describe("the loss episode names exactly one revocation, for the pause's own loss", () => {
  it("a legacy pause whose loss reason is not its pass's revocation's is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await rewritingPass(
        f,
        { pause: (call) => ({ ...OLD_CODE.pause(call), reason: CONTINUITY_COVERAGE_REVOCATION_REASON }) },
        () => restart(f, ready),
      );
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it.each([
    ["another role whose loss pauses this run, for the same loss", "BLIND_REVIEWER", CONTINUITY_RUNTIME_CREDENTIAL_LOST_REASON],
    ["the owner's role a second time, for another reason", "OWNER", "operator hold"],
  ] as const)("a legacy pass that also deferred %s is kept (ambiguous)", async (_case, which, extraReason) => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const bindings = f.harness.cp.bindings;
      const revoke = bindings.revoke.bind(bindings);
      const second = vi.spyOn(bindings, "revoke").mockImplementation((roleKey, reason, options) => {
        const revoked = revoke(roleKey, reason, options);
        if (roleKey === ready.roleKey) {
          f.harness.cp.audit.record({
            kind: "CONTINUITY_REVOKE_DEFERRED",
            roleKey: which === "OWNER" ? ready.roleKey : roleKeyFor(Role.BLIND_REVIEWER, { runId: ready.runId }),
            sessionId: which === "OWNER" ? ready.ownerSessionId : f.ceoSessionId,
            evidence: { reason: extraReason },
          });
        }
        return revoked;
      });
      await legacyRestart(f, ready);
      second.mockRestore();
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a legacy pause whose own pass deferred the owner's revocation (the old row has no generation) is kept when coverage returns", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      f.loseClaude();
      await rewritingPass(f, OLD_CODE, () => f.daemon.reconcileContinuity("claude coverage lost, as the old daemon ran it"));
      expect(f.harness.cp.audit.byKind("CONTINUITY_REVOKE_DEFERRED").filter((e) => e.roleKey === ready.roleKey).at(-1)?.evidence)
        .toEqual({ reason: CONTINUITY_COVERAGE_REVOCATION_REASON });
      const count = transitions(f, ready.runId).length;
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");
      expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({ state: RunState.AWAITING_HUMAN, ownerBindingGeneration: 1 });
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });
});

describe("only the owner the pause took the run from gets the wait back: same role, session and incarnation", () => {
  it.each([
    ["a new-shape pause", restart],
    ["a legacy pause", legacyRestart],
  ] as const)("%s: a holder on another session, pinned to the run now, does not release it", async (_shape, pause) => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await pause(f, ready);
      expect(f.harness.cp.bindings.active(ready.roleKey)).toBeNull();
      const count = transitions(f, ready.runId).length;
      const other = f.harness.cp.sessions.create({ provider: "claude", model: "replacement" });
      f.harness.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "a replacement bootstrap CTO");
      const bound = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: ready.runId, sessionId: other.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      expect(f.harness.cp.runs.reassignOwner(ready.runId, bound.value, "a replacement took the role").allowed).toBe(true);
      expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({ ownerSessionId: other.sessionId, ownerRoleKey: ready.roleKey });
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, bound.value))
        .toMatchObject({ allowed: true, value: { released: false } });
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });

  // Review r2 (RH-R2-01): the replacement above differs in session and incarnation both, so it could not
  // tell a dropped session comparison apart. Here only the session differs.
  it.each([
    ["a new-shape pause", restart],
    ["a legacy pause", legacyRestart],
  ] as const)("%s: a holder on another session carrying the owner's incarnation value does not release it", async (_shape, pause) => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await pause(f, ready);
      expect(f.harness.cp.bindings.active(ready.roleKey)).toBeNull();
      const count = transitions(f, ready.runId).length;
      const other = f.harness.cp.sessions.create({
        provider: "claude",
        model: "replacement",
        incarnation: f.harness.cp.sessions.require(ready.ownerSessionId).incarnation,
      });
      f.harness.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "a replacement bootstrap CTO");
      const bound = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: ready.runId, sessionId: other.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      expect(f.harness.cp.runs.reassignOwner(ready.runId, bound.value, "a replacement took the role").allowed).toBe(true);
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, bound.value))
        .toMatchObject({ allowed: true, value: { released: false } });
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });

  it("a new-shape pause that recorded another incarnation of the owner's session is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restartWithPause(f, ready, (evidence) => ({ ...evidence, ownerSessionIncarnation: "inc_an_earlier_incarnation" }));
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a new-shape pause whose recorded owner is not the binding its pass revoked is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restartWithPause(f, ready, (evidence) => ({ ...evidence, ownerBindingGeneration: 0 }));
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a new-shape pause that recorded no owner is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      await restartWithPause(f, ready, ({
        ownerSessionId: _session,
        ownerSessionIncarnation: _incarnation,
        ownerBindingGeneration: _generation,
        ...evidence
      }) => evidence);
      expect(transitions(f, ready.runId).at(-1)).toMatchObject({ continuityHold: ready.roleKey });
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("the pause records the run's owner, and its generation differing from the releasing one does not keep the wait", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const pinned = f.harness.cp.runs.require(ready.runId);
      const before = sideEffects(f, ready.runId);
      await restart(f, ready);
      expect(transitions(f, ready.runId).at(-1)).toMatchObject({
        ownerSessionId: pinned.ownerSessionId,
        ownerSessionIncarnation: pinned.ownerSessionIncarnation,
        ownerBindingGeneration: 1,
      });
      await recover(f, ready);
      expectReleased(f, ready, before, 2);
    });
  });
});

describe("the release is one transaction", () => {
  it("a failure on ACTIVE → READY_FOR_CEO_REVIEW rolls both edges and their audit rows back", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      f.loseClaude();
      await f.daemon.reconcileContinuity("claude coverage lost");
      const binding = f.harness.cp.bindings.active(ready.roleKey)!;
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      const count = transitions(f, ready.runId).length;
      const db = f.harness.cp.db;
      const run = db.run.bind(db);
      const failing = vi.spyOn(db, "run").mockImplementation((sql, params = []) => {
        if (sql.startsWith("UPDATE runs SET state = ?, state_reason = ? WHERE") && params[0] === RunState.READY_FOR_CEO_REVIEW) {
          throw new Error("injected edge failure");
        }
        return run(sql, params);
      });
      expect(() => f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, binding)).toThrow("injected edge failure");
      failing.mockRestore();
      expect(f.harness.cp.runs.require(ready.runId)).toMatchObject({ state: RunState.AWAITING_HUMAN, ownerBindingGeneration: 1 });
      expect(transitions(f, ready.runId)).toHaveLength(count);
      // Nothing half-done is left behind: the same release, unhindered, goes through once.
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, binding)).toMatchObject({ allowed: true, value: { released: true } });
      expect(transitions(f, ready.runId)).toHaveLength(count + 2);
    });
  });
});
