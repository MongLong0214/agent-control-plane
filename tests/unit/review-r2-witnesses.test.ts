import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow } from "../../src/core/errors.ts";
import { RunState } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { IN_BAND_REWAKE_MS } from "../../src/outbox/outbox.ts";
import { BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS } from "../../src/run/bootstrap-cto-staffing.ts";
import { acknowledgeInBandOnWorkTurns, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, makeDb } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

describe("ROUND1-ESCAPE-01: a successful CLI return does not settle an unacknowledged envelope", () => {
  it.each(["no tool call", "relay never takes its credential"] as const)("retries RUN_DISPATCH after %s", async (cause) => {
    await withBootstrapRuntime(async (f) => {
      // Attestation still succeeds. Only the subsequent work turn does nothing.
      if (cause === "relay never takes its credential") {
        const turn = f.claude.runSessionTurn.bind(f.claude);
        vi.spyOn(f.claude, "runSessionTurn").mockImplementation(async (request) => {
          f.claude.takeCredential = /session_attest/.test(request.prompt);
          return turn(request);
        });
      }
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      const pending = () => f.harness.cp.outbox.listByRun(runId).filter((m) => m.kind === MessageKind.RUN_DISPATCH);
      expect(pending().map((m) => m.status)).toEqual(["PENDING"]);
      const handled = acknowledgeInBandOnWorkTurns(f);
      vi.restoreAllMocks();
      f.claude.takeCredential = true;
      f.harness.clock.advance(IN_BAND_REWAKE_MS);
      await f.harness.cp.outbox.wakeInBandPending();
      const refusals = f.harness.cp.db.all<{ reason_code: string }>(
        "SELECT reason_code FROM audit_events WHERE kind = 'OUTBOX_IN_BAND_WAKE_FAILED'",
      );
      process.stdout.write(`UNACKED-WITNESS ${JSON.stringify({ cause, turns: f.finishedTurns(ownerSessionId), messages: pending().map((m) => m.status), refusals, handled })}\n`);
      expect(refusals).toEqual([]);
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(3));
      expect(handled).toEqual([{ kind: MessageKind.RUN_DISPATCH, generation: 1, acked: true }]);
      expect(pending().map((m) => m.status)).toEqual(["ACKED"]);
    });
  });
});

describe("repair recovery siblings", () => {
  it("the only-while-BLOCKED guard independently refuses an authorized state edge that forgets to clear the hold", () => {
    const db = makeDb();
    try {
      db.run("INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at) VALUES ('hold-check', 'PROJECT_BOOTSTRAP', 'STANDARD', 'NORMAL', 'QUEUED', 'g', 'd', 'now')");
      const authority = db.claimRunStateTransitionAuthority();
      const move = (state: string, withHold: boolean) => db.applyRunStateTransition(authority, {
        runId: "hold-check", toState: state,
        recordTransitionEvidence: () => allow(ReasonCode.OK, undefined),
        enqueueTransitionEnvelope: () => allow(ReasonCode.OK, undefined),
        updateState: () => db.run(withHold
          ? "UPDATE runs SET state = ?, continuity_hold_role_key = 'BOOTSTRAP_CTO:hold-check' WHERE run_id = 'hold-check'"
          : "UPDATE runs SET state = ? WHERE run_id = 'hold-check'", [state]),
      });
      move("ACTIVE", false);
      move("BLOCKED", true);
      expect(() => move("ACTIVE", false)).toThrow(/RUN_CONTINUITY_HOLD_DENIED|authority/i);
      expect(db.get<{state: string}>("SELECT state FROM runs WHERE run_id = 'hold-check'")?.state).toBe("BLOCKED");
    } finally {
      db.close();
    }
  });

  it.each([RunState.REVISION_REQUIRED, RunState.AWAITING_HUMAN] as const)("failed recovery of %s leaves no holder and can retry after backoff", async (state) => {
    await withBootstrapRuntime(async (f) => {
      acknowledgeInBandOnWorkTurns(f);
      const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      expect(f.harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "review fixture").allowed).toBe(true);
      expect(f.harness.cp.runs.transition(runId, state, "semantic hold fixture").allowed).toBe(true);
      f.harness.cp.sessionRuntime.release(ownerSessionId);
      await f.daemon.reconcileContinuity("credential lost");
      f.claude.presentAttestation = false;
      await f.daemon.reconcileContinuity("failed recovery");
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state, ownerBindingGeneration: 1 });
      expect(f.harness.cp.db.all("SELECT * FROM audit_events WHERE kind = 'BOOTSTRAP_CTO_RECOVERY_REVOKE_DEFERRED'")).toEqual([]);
      f.claude.presentAttestation = true;
      f.harness.clock.advance(BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS + 1);
      await f.daemon.reconcileContinuity("recovery retry");
      expect(f.harness.cp.bindings.active(roleKey)?.bindingGeneration).toBe(3);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state, ownerBindingGeneration: 3 });
      expect(f.harness.cp.outbox.listByRun(runId).filter((m) => m.kind === MessageKind.RUN_DISPATCH)).toHaveLength(1);
    });
  });

  it("two bootstrap revision cycles each execute exactly one new work turn", async () => {
    await withBootstrapRuntime(async (f) => {
      const handled = acknowledgeInBandOnWorkTurns(f);
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      for (let revision = 1; revision <= 2; revision++) {
        expect(f.harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "review fixture").allowed).toBe(true);
        expect(f.harness.cp.runs.transition(runId, RunState.REVISION_REQUIRED, "revision fixture").allowed).toBe(true);
        expect(await f.hermes("run_dispatch", { runId })).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2 + 2 * revision));
        expect(await f.hermes("run_dispatch", { runId })).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
      }
      expect(handled).toHaveLength(3);
      expect(f.harness.cp.outbox.listByRun(runId).filter((m) => m.kind === MessageKind.RUN_DISPATCH)
        .map((m) => [m.idempotencyKey, m.status]).sort()).toEqual([
          [`run-dispatch:${runId}:1`, "ACKED"],
          [`run-dispatch:${runId}:1:r1`, "ACKED"],
          [`run-dispatch:${runId}:1:r2`, "ACKED"],
        ]);
    });
  });
});
