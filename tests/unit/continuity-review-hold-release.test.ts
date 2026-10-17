import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTINUITY_COVERAGE_REVOCATION_REASON,
  CONTINUITY_RUNTIME_CREDENTIAL_LOST_REASON,
} from "../../src/continuity/continuity-kernel.ts";
import { ArtifactKind, ExecutionMode, Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { reviewerPass } from "../helpers/harness.ts";

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

/**
 * The same restart as the code before this change handled it, in the same order within one pass: the
 * pause's RUN_TRANSITION with the old evidence (no `continuityHold`, no candidate — and the `roleKey`
 * it did carry is redacted by the audit log), then the paused role's revocation.
 */
const legacyRestart = (f: BootstrapRuntimeFixture, ready: ReviewReady) => {
  f.harness.cp.sessionRuntime.release(ready.ownerSessionId);
  legacyPauseFor(f, ready, ready.roleKey);
  expect(f.harness.cp.bindings.revoke(ready.roleKey, CONTINUITY_RUNTIME_CREDENTIAL_LOST_REASON, {
    allowBlockedRuns: true,
    allowHeldRuns: true,
    holdEscalationRepliesForRenewal: true,
  }).allowed).toBe(true);
};

const legacyPauseFor = (f: BootstrapRuntimeFixture, ready: ReviewReady, roleKey: string) => {
  const paused = f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, CONTINUITY_RUNTIME_CREDENTIAL_LOST_REASON, {
    roleKey,
    continuityAction: "PAUSE_NEW_WORK",
  });
  expect(paused.allowed).toBe(true);
};

/** The next sweeps: restore recovers the same session at the next generation. */
const recover = async (f: BootstrapRuntimeFixture, ready: ReviewReady) => {
  for (let tick = 0; tick < 2 && f.harness.cp.bindings.active(ready.roleKey) === null; tick += 1) {
    await f.daemon.reconcileContinuity(`recovery tick ${tick}`);
  }
  expect(f.harness.cp.bindings.active(ready.roleKey)).toMatchObject({ bindingGeneration: 2, sessionId: ready.ownerSessionId });
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

  it("a legacy pause row (no continuityHold) is released by the same recovery, through an earlier owner renewal", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      const before = sideEffects(f, ready.runId);
      legacyRestart(f, ready);
      // The redaction that makes the legacy row's own `roleKey` unreadable.
      expect(transitions(f, ready.runId).at(-1)).toMatchObject({ roleKey: "[redacted]", continuityAction: "PAUSE_NEW_WORK" });
      expect(transitions(f, ready.runId).at(-1)).not.toHaveProperty("continuityHold");
      // What the old recovery left on the live run: the owner renewed, the run kept waiting.
      f.harness.cp.audit.record({
        kind: "RUN_OWNER_RENEWED",
        runId: ready.runId,
        sessionId: ready.ownerSessionId,
        evidence: { state: RunState.AWAITING_HUMAN, fromGeneration: 0, toGeneration: 1 },
      });
      await recover(f, ready);
      expectReleased(f, ready, before);
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
      legacyRestart(f, ready);
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
      legacyPauseFor(f, ready, roleKeyFor(Role.CEO));
      expect(f.harness.cp.bindings.revoke(roleKeyFor(Role.CEO), CONTINUITY_COVERAGE_REVOCATION_REASON, { allowBlockedRuns: true }).allowed)
        .toBe(true);
      const count = transitions(f, ready.runId).length;
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a new-shape pause whose continuityHold names a different role is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      expect(f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, "paused", {
        continuityAction: "PAUSE_NEW_WORK",
        continuityHold: roleKeyFor(Role.CEO),
        candidateSnapshotDigest: ready.candidate,
      }).allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a new-shape pause whose candidate is not the current one is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      expect(f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, "paused", {
        continuityAction: "PAUSE_NEW_WORK",
        continuityHold: ready.roleKey,
        candidateSnapshotDigest: "sha256:another-candidate",
      }).allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a pause whose action is not continuity's PAUSE_NEW_WORK is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      expect(f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, "paused", {
        continuityHold: ready.roleKey,
        candidateSnapshotDigest: ready.candidate,
      }).allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      await restart(f, ready);
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
      legacyRestart(f, ready);
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
      legacyRestart(f, ready);
      const count = transitions(f, ready.runId).length;
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a pause whose own row does not leave READY_FOR_CEO_REVIEW is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      expect(f.harness.cp.runs.transition(ready.runId, RunState.AWAITING_HUMAN, "paused", {
        from: RunState.ACTIVE,
        continuityAction: "PAUSE_NEW_WORK",
        continuityHold: ready.roleKey,
        candidateSnapshotDigest: ready.candidate,
      }).allowed).toBe(true);
      const count = transitions(f, ready.runId).length;
      await restart(f, ready);
      await recover(f, ready);
      expectKept(f, ready, count);
    });
  });

  it("a candidate whose packet is no longer current is kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const ready = await reviewReady(f);
      legacyRestart(f, ready);
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
      legacyPauseFor(f, ready, ready.roleKey);
      f.harness.cp.audit.record({
        kind: "CONTINUITY_REVOKE_DEFERRED",
        roleKey: ready.roleKey,
        sessionId: ready.ownerSessionId,
        evidence: { reason: "operator hold" },
      });
      const count = transitions(f, ready.runId).length;
      expect(f.harness.cp.runs.releaseContinuityReviewHold(ready.runId, binding)).toMatchObject({ allowed: true, value: { released: false } });
      expect(f.harness.cp.runs.require(ready.runId).state).toBe(RunState.AWAITING_HUMAN);
      expect(transitions(f, ready.runId)).toHaveLength(count);
    });
  });
});
