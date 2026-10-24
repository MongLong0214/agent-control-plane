import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS } from "../../src/run/bootstrap-cto-staffing.ts";
import {
  type BootstrapRuntimeFixture,
  openHeldCtoConnection,
  withBootstrapRuntime,
} from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 PR-C slice C1b — a run's BOOTSTRAP_CTO that continuity revoked when Claude stopped
 * covering it comes back on its own session, through the existing restore path, in the order the
 * CEO fixed: capacity → a `--resume` probe → one rotation (credential epoch +1, a new secret,
 * binding generation +1 for the same actor and session, run still BLOCKED) → the new credential
 * delivered to that session's runtime → an authenticated attestation → only then the owner pin,
 * ACTIVE and RUN_DISPATCH. Every row goes through the real sockets and the real launch channel;
 * only the model is scripted (`HeadlessRuntimeDouble`).
 */

const actorOf = (f: BootstrapRuntimeFixture, assignmentId: string): string | undefined =>
  f.harness.cp.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE assignment_id = ?`, [assignmentId])?.actor_id;

const runDispatches = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "RUN_DISPATCH")
    .map((message) => ({ bindingGeneration: message.bindingGeneration, status: message.status }));

const history = (f: BootstrapRuntimeFixture, roleKey: string) =>
  f.harness.cp.bindings.history(roleKey).map((held) => ({
    generation: held.bindingGeneration,
    sessionId: held.boundSessionId,
    status: held.status,
    actor: actorOf(f, held.assignmentId),
  }));

/** Dispatch, then lose Claude: the binding is revoked and the run paused by continuity. */
const outage = async (f: BootstrapRuntimeFixture) => {
  const dispatched = await f.dispatchBootstrap();
  // The RUN_DISPATCH wake starts a turn of the conversation; let it finish first.
  await f.awaitFinishedTurns(dispatched.ownerSessionId, 1);
  f.loseClaude();
  await f.daemon.reconcileContinuity("claude coverage lost");
  expect(f.harness.cp.bindings.active(dispatched.roleKey)).toBeNull();
  expect(f.harness.cp.runs.require(dispatched.runId).state).toBe(RunState.BLOCKED);
  return dispatched;
};

describe("C1b: a revoked BOOTSTRAP_CTO is recovered on its own session, in the CEO's order", () => {
  it("outage → restore: probe, rotate (epoch+1, gen+1, same actor and session), deliver, attest, then ACTIVE and RUN_DISPATCH — every turn the same conversation in the same workdir", async () => {
    await withBootstrapRuntime(async (f) => {
      // Each work turn reads what is addressed to it in band and acknowledges it, over the
      // connection its relay authenticated with the credential the daemon delivered for that turn.
      const handled: Array<{ generation: number; acked: unknown }> = [];
      f.claude.onWorkTurn = async (_request, credential) => {
        if (!credential) return;
        const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
        const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
        const messages = ((pending["value"] as { messages?: Array<{ messageId: string; runId: string | null; kind: string }> } | undefined)
          ?.messages ?? []).filter((message) => message.kind === "RUN_DISPATCH");
        for (const message of messages) {
          const row = f.harness.cp.outbox.get(message.messageId);
          const acked = await callMcpToolOverSocket(f.ctoSocket, as, "run_ack", {
            idempotencyKey: `ack-${message.messageId}`,
            runId: message.runId,
            messageId: message.messageId,
          });
          handled.push({ generation: row?.bindingGeneration ?? -1, acked: acked["ok"] });
        }
      };
      const { runId, ownerSessionId, roleKey } = await outage(f);
      // The first generation's dispatch was read in band and settled by its own turn.
      expect(handled).toEqual([{ generation: 1, acked: true }]);
      const before = f.harness.cp.sessions.require(ownerSessionId);
      const actor = actorOf(f, f.harness.cp.bindings.history(roleKey)[0]!.assignmentId);
      expect(before).toMatchObject({ lifecycle: SessionLifecycle.READY, credentialEpoch: 0 });

      f.restoreClaude();
      const report = await f.daemon.reconcileContinuity("claude coverage returned");
      expect(report?.restored).toContain(roleKey);

      // Same session, same incarnation; the credential rotated once.
      expect(f.harness.cp.sessions.require(ownerSessionId)).toMatchObject({
        lifecycle: SessionLifecycle.READY,
        incarnation: before.incarnation,
        workdir: before.workdir,
        credentialEpoch: 1,
      });
      // The next generation, for the same actor on the same session.
      expect(history(f, roleKey)).toEqual([
        { generation: 1, sessionId: ownerSessionId, status: "REVOKED", actor },
        { generation: 2, sessionId: ownerSessionId, status: "ACTIVE", actor },
      ]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({
        state: RunState.ACTIVE,
        ownerSessionId,
        ownerBindingGeneration: 2,
        ownerSessionIncarnation: before.incarnation,
      });
      expect(runDispatches(f, runId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ bindingGeneration: 2 }),
      ]));
      // The recovered generation's RUN_DISPATCH starts a turn of the same conversation, which reads
      // it in band — it was never handed to Buzz — and settles it.
      await vi.waitFor(() => expect(f.claude.turns).toHaveLength(2));
      await vi.waitFor(() => expect(handled).toEqual([{ generation: 1, acked: true }, { generation: 2, acked: true }]));
      expect(f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "RUN_DISPATCH")
        .map((message) => [message.bindingGeneration, message.status]).sort()).toEqual([[1, "ACKED"], [2, "ACKED"]]);
      const turns = f.claude.turns.map((turn) => ({
        conversation: turn.conversation,
        relay: turn.relay !== null,
        externalSessionId: turn.handle.externalSessionId,
        workdir: turn.handle.workdir,
        attestation: /session_attest/.test(turn.prompt),
      }));
      const conversation = before.incarnation.split("#", 1)[0];
      expect(turns).toEqual([
        { conversation: "new", relay: true, externalSessionId: conversation, workdir: before.workdir, attestation: false },
        // Recovery uses direct liveness and authentication; only the resumed work is a model turn.
        { conversation: "resume", relay: true, externalSessionId: conversation, workdir: before.workdir, attestation: false },
      ]);
      // The ledger orders the decision: the attestation at epoch 1 precedes the run's resume.
      const kinds = f.harness.cp.db.all<{ kind: string }>(
        `SELECT kind FROM audit_events
          WHERE kind IN ('SESSION_CREDENTIAL_ROTATED','BINDING_RENEWED','SESSION_ATTESTED','BOOTSTRAP_CTO_RECOVERED')
            AND event_id > (SELECT MAX(event_id) FROM audit_events WHERE kind = 'BINDING_REVOKED')
          ORDER BY event_id`,
      ).map((row) => row.kind);
      expect(kinds).toEqual(["SESSION_CREDENTIAL_ROTATED", "BINDING_RENEWED", "SESSION_ATTESTED", "BOOTSTRAP_CTO_RECOVERED"]);
    });
  });

  it("the previous credential is refused at the handshake, and a connection opened before the rotation is refused at its next request", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await outage(f);
      const previous = { ...f.claude.credentials.get(ownerSessionId)! };
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");
      expect(f.harness.cp.runs.require(runId).ownerBindingGeneration).toBe(2);

      const current = { ...f.claude.credentials.get(ownerSessionId)! };
      expect(current.sessionSecret).not.toBe(previous.sessionSecret);
      // The new credential works, over a connection held open from here on.
      const live = await openHeldCtoConnection(f.ctoSocket, current);
      if (!("call" in live)) throw new Error(`the new credential was refused: ${JSON.stringify(live.refused)}`);
      expect(await live.call("role_dispatch_pending", {})).toMatchObject({ ok: true });
      // The previous one is refused at the handshake.
      expect(await openHeldCtoConnection(f.ctoSocket, previous)).toMatchObject({
        refused: { ok: false, reasonCode: ReasonCode.SESSION_SECRET_INVALID },
      });

      // A second outage and recovery rotate the credential again: the connection that authenticated
      // at epoch 1 is refused at its very next request, without being reopened.
      f.loseClaude();
      await f.daemon.reconcileContinuity("claude coverage lost again");
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned again");
      expect(f.harness.cp.bindings.active(roleKey)?.bindingGeneration).toBe(3);
      expect(f.harness.cp.sessions.require(ownerSessionId).credentialEpoch).toBe(2);
      expect(await live.call("role_dispatch_pending", {})).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.SESSION_SECRET_INVALID,
      });
      live.close();
    });
  });
});

describe("C1b: each recovery failure point leaves the run BLOCKED, with no duplicate holder and no dispatch", () => {
  const rows: Array<{ name: string; arrange: (f: BootstrapRuntimeFixture) => void; generations: number; epoch: number }> = [
    {
      name: "rotation refused",
      arrange: (f) => {
        vi.spyOn(f.harness.cp.sessions, "rotateSecret").mockReturnValueOnce(
          deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "fixture: the rotation lost its race", {}),
        );
      },
      generations: 1,
      epoch: 0,
    },

  ];

  it.each(rows)("$name", async ({ arrange, generations, epoch }) => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await outage(f);
      arrange(f);
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");

      expect(f.harness.cp.runs.require(runId)).toMatchObject({
        state: RunState.BLOCKED,
        ownerSessionId,
        ownerBindingGeneration: 1,
      });
      // No holder at all: a generation the recovery renewed is revoked again, as owed.
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      expect(f.harness.cp.bindings.history(roleKey).map((held) => held.status)).toEqual(
        Array.from({ length: generations }, () => "REVOKED"),
      );
      expect(runDispatches(f, runId).map((message) => message.bindingGeneration)).toEqual([1]);
      expect(f.harness.cp.sessions.require(ownerSessionId)).toMatchObject({
        lifecycle: SessionLifecycle.READY,
        credentialEpoch: epoch,
      });
      expect(f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'BOOTSTRAP_CTO_RECOVERY_REFUSED' AND role_key = ?`, [roleKey],
      )?.n).toBe(1);
    });
  });

  it("a failed recovery backs off: the next restore pass spends no provider turn until the window passes", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, roleKey } = await outage(f);
      f.restoreClaude();
      const probe = vi.spyOn(f.claude, "probeRuntime").mockResolvedValueOnce("HEALTHY").mockResolvedValueOnce("UNAVAILABLE");
      await f.daemon.reconcileContinuity("claude coverage returned");
      const turns = f.claude.turns.length;

      probe.mockRestore();
      await f.daemon.reconcileContinuity("next tick");
      expect(f.claude.turns).toHaveLength(turns);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
      // A pass that withholds restoration records claim needs instead; a bootstrap CTO has none.
      expect(f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'CONTINUITY_RESTORE_AWAITS_CLAIM' AND role_key = ?`, [roleKey],
      )?.n).toBe(0);

      f.harness.clock.advance(BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS + 1);
      await f.daemon.reconcileContinuity("after the backoff");
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.ACTIVE, ownerBindingGeneration: 3 });
      expect(f.harness.cp.bindings.active(roleKey)?.bindingGeneration).toBe(3);
    });
  });

  it("two recoveries at once: one runs, the other is refused, and there is one holder", async () => {
    await withBootstrapRuntime(async (f) => {
      const { roleKey } = await outage(f);
      f.restoreClaude();
      const [first, second] = await Promise.all([
        f.harness.cp.bootstrapCtos.recover(roleKey),
        f.harness.cp.bootstrapCtos.recover(roleKey),
      ]);
      expect([first.allowed, second.allowed].sort()).toEqual([false, true]);
      expect([first, second].find((decision) => !decision.allowed)).toMatchObject({ reasonCode: ReasonCode.CONFLICT });
      expect(f.harness.cp.bindings.history(roleKey).map((held) => held.status)).toEqual(["REVOKED", "ACTIVE"]);
    });
  });
});

describe("C1b: ended runs and stopped sessions are never reactivated", () => {
  it.each([RunState.CANCELLED, RunState.FAILED] as const)("a %s run is not recovered, by restore or directly", async (ended) => {
    await withBootstrapRuntime(async (f) => {
      const { runId, roleKey, ownerSessionId } = await outage(f);
      expect(f.harness.cp.runs.transition(runId, ended, "ended while its CTO was revoked").allowed).toBe(true);
      const turns = f.claude.turns.length;
      f.restoreClaude();
      const report = await f.daemon.reconcileContinuity("claude coverage returned");
      expect(report?.restored ?? []).not.toContain(roleKey);
      expect(await f.harness.cp.bootstrapCtos.recover(roleKey)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.RUN_ALREADY_TERMINAL,
      });
      expect(f.harness.cp.runs.require(runId).state).toBe(ended);
      expect(f.harness.cp.bindings.history(roleKey).map((held) => held.status)).toEqual(["REVOKED"]);
      expect(f.harness.cp.sessions.require(ownerSessionId).credentialEpoch).toBe(0);
      expect(f.claude.turns).toHaveLength(turns);
    });
  });

  it("a COMPLETED run's binding is released, not lost to an outage, and is never recovered", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, roleKey, ownerSessionId } = await f.dispatchBootstrap();
      await f.awaitFinishedTurns(ownerSessionId, 1);
      // The terminal transition's own revocation (`bootstrap run ended: …`) is not a continuity one.
      expect(f.harness.cp.runs.transition(runId, RunState.CANCELLED, "withdrawn").allowed).toBe(true);
      expect(await f.harness.cp.bootstrapCtos.recover(roleKey)).toMatchObject({ allowed: false });
      expect(f.harness.cp.bindings.history(roleKey).map((held) => held.status)).toEqual(["REVOKED"]);
    });
  });

  it("a STOPPED session is not recovered; its run stays BLOCKED", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, roleKey, ownerSessionId } = await outage(f);
      f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.STOPPED, "stopped while revoked");
      const turns = f.claude.turns.length;
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, ownerBindingGeneration: 1 });
      expect(f.harness.cp.bindings.history(roleKey).map((held) => held.status)).toEqual(["REVOKED"]);
      expect(f.claude.turns).toHaveLength(turns);
      expect(f.harness.cp.db.get<{ reason_code: string }>(
        `SELECT reason_code FROM audit_events WHERE kind = 'BOOTSTRAP_CTO_RECOVERY_REFUSED' AND role_key = ? ORDER BY event_id DESC LIMIT 1`,
        [roleKey],
      )?.reason_code).toBe(ReasonCode.SESSION_NOT_READY);
    });
  });
});

describe("C1b: a restarted daemon holds no credential, and recovers the same session rather than stranding it", () => {
  it("the next reconcile revokes and pauses the bootstrap CTO whose credential is gone, and restore recovers it on the same session", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
      await f.awaitFinishedTurns(ownerSessionId, 1);
      // What a restart leaves: the row, the binding and the run, and no plaintext in memory.
      f.harness.cp.sessionRuntime.release(ownerSessionId);
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{ id: "after-restart", kind: "test" }])).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_RUNTIME_UNAVAILABLE,
      });

      const first = await f.daemon.reconcileContinuity("first tick after a restart");
      expect(first?.pausedRuns).toContainEqual(expect.objectContaining({ runId, roleKey }));
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
      expect(f.harness.cp.sessions.require(ownerSessionId).lifecycle).toBe(SessionLifecycle.READY);
      // The next tick's restore pass is the recovery: no other path starts one.
      const second = await f.daemon.reconcileContinuity("next tick");
      expect(second?.restored).toContain(roleKey);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.ACTIVE, ownerSessionId, ownerBindingGeneration: 2 });
      expect(f.harness.cp.sessions.require(ownerSessionId).credentialEpoch).toBe(1);
      expect(f.harness.cp.sessionRuntime.holds(ownerSessionId)).toBe(true);
    });
  });
});

describe("C1-02: continuity records no claim need for a bootstrap CTO", () => {
  it("a pass that only records claim needs records none for a revoked bootstrap CTO its runtime can cover again", async () => {
    await withBootstrapRuntime(async (f) => {
      const { roleKey } = await outage(f);
      f.restoreClaude();
      await f.harness.cp.continuity.evaluate("claude coverage returned");
      expect(f.harness.cp.continuity.computeCoveragePlan().restorationPending).toContain(roleKey);
      expect(f.harness.cp.bootstrapCtos.backingOff(roleKey)).toBe(false);
      expect(f.harness.cp.continuity.recordClaimNeeds()).toEqual([]);
      expect(f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'CONTINUITY_RESTORE_AWAITS_CLAIM' AND role_key = ?`, [roleKey],
      )?.n).toBe(0);
    });
  });

  it("restore recovers the role instead of recording CONTINUITY_RESTORE_AWAITS_CLAIM", async () => {
    await withBootstrapRuntime(async (f) => {
      const { roleKey } = await outage(f);
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");
      expect(f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'CONTINUITY_RESTORE_AWAITS_CLAIM' AND role_key = ?`, [roleKey],
      )?.n).toBe(0);
      expect(f.harness.cp.bindings.active(roleKey)?.role).toBe(Role.BOOTSTRAP_CTO);
    });
  });
});


/** A CEO hold keeps restoration from creating a new RUN_DISPATCH that could mask the lost wake. */
const pendingRecovery = async (f: BootstrapRuntimeFixture) => {
  const dispatched = await f.dispatchBootstrap();
  await f.awaitFinishedTurns(dispatched.ownerSessionId, 1);
  const pending = f.harness.cp.outbox.listByRun(dispatched.runId).find(m => m.kind === "RUN_DISPATCH")!;
  expect(pending.status).toBe("PENDING");
  expect(await f.cto(dispatched.ownerSessionId, "escalation_open", { runId: dispatched.runId,
    question: "wait for compiled input", options: ["wait"], ctoRecommendation: "wait", whyItMatters: "input", blocksCriticalPath: true }))
    .toMatchObject({ ok: true });
  f.loseClaude();
  await f.daemon.reconcileContinuity("pending owner lost its credential");
  expect(f.harness.cp.runs.require(dispatched.runId)).toMatchObject({ state: "BLOCKED", continuityHoldRoleKey: null });
  f.restoreClaude();
  return { ...dispatched, messageId: pending.messageId };
};

describe("B5 recovered bootstrap owner gets its pending in-band wake after credentials and owner restoration", () => {
  it("preserves the early failed handover audit, then wakes the same id once and the recovered owner claims and ACKs it without processing twice", async () => {
    await withBootstrapRuntime(async f => {
      const { runId, ownerSessionId, roleKey, messageId } = await pendingRecovery(f);
      const cp = f.harness.cp;
      const calls: Array<{ held: boolean; ids: string[]; allowed: boolean }> = [];
      const wake = cp.sessionRuntime.wake.bind(cp.sessionRuntime);
      vi.spyOn(cp.sessionRuntime, "wake").mockImplementation((role, triggers) => {
        const held = cp.sessionRuntime.holds(ownerSessionId);
        const result = wake(role, triggers);
        calls.push({ held, ids: triggers.map(t => t.id), allowed: result.allowed });
        return result;
      });
      const order: string[] = [];
      const adopt = cp.sessionRuntime.adopt.bind(cp.sessionRuntime);
      vi.spyOn(cp.sessionRuntime, "adopt").mockImplementation((...args) => { order.push("adopt"); return adopt(...args); });
      const attest = cp.sessionRuntime.attest.bind(cp.sessionRuntime);
      vi.spyOn(cp.sessionRuntime, "attest").mockImplementation(async (...args) => { const result = await attest(...args); order.push("attest"); return result; });
      const restore = cp.runs.restoreRecoveredBootstrapOwner.bind(cp.runs);
      vi.spyOn(cp.runs, "restoreRecoveredBootstrapOwner").mockImplementation((...args) => { const result = restore(...args); order.push("restore"); return result; });
      const processed: string[] = [];
      let finish!: () => void;
      const processing = new Promise<void>(resolve => { finish = resolve; });
      f.claude.onWorkTurn = async (_request, credential) => {
        if (!credential) return;
        order.push("claim");
        const result = await f.cto(ownerSessionId, "role_dispatch_pending", {});
        const messages = (result.value as { messages: Array<{ messageId: string; bindingGeneration: number }> }).messages;
        expect(messages).toContainEqual(expect.objectContaining({ messageId, bindingGeneration: 2 }));
        processed.push(messageId);
        await processing;
        expect(await f.cto(ownerSessionId, "run_ack", { runId, messageId })).toMatchObject({ ok: true });
      };
      const before = cp.outbox.listByRun(runId).map(m => m.messageId);
      try {
        expect(await cp.bootstrapCtos.recover(roleKey)).toMatchObject({ allowed: true });
        await vi.waitFor(() => expect(processed).toEqual([messageId]));
        expect(calls).toEqual([
          { held: false, ids: [messageId], allowed: false },
          { held: true, ids: [messageId], allowed: true },
        ]);
        expect(order).toEqual(["adopt", "attest", "restore", "claim"]);
        expect(cp.outbox.get(messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 2, attempts: 0 });
        const scope = { runId, roleKey, targetSessionId: ownerSessionId,
          sessionIncarnation: cp.sessions.require(ownerSessionId).incarnation, bindingGeneration: 2 };
        // Even an explicit second wake cannot process a trigger the runtime already claimed.
        await cp.outbox.wakeInBandPending(scope);
        expect(processed).toEqual([messageId]);
        finish();
        await f.awaitFinishedTurns(ownerSessionId, 2);
        expect(cp.outbox.get(messageId)?.status).toBe("ACKED");
        await cp.outbox.wakeInBandPending(scope);
        expect(processed).toEqual([messageId]);
        expect(cp.outbox.listByRun(runId).map(m => m.messageId)).toEqual(before);
        const events = cp.audit.all();
        const early = events.find(e => e.kind === "OUTBOX_IN_BAND_WAKE_FAILED" && e.evidence["trigger"] === "handover" && e.roleKey === roleKey)!;
        const attested = events.find(e => e.kind === "SESSION_ATTESTED" && e.sessionId === ownerSessionId && e.eventId > early.eventId)!;
        expect(early).toBeDefined();
        expect(early.eventId).toBeLessThan(attested.eventId);
        expect(events.some(e => e.kind === "BOOTSTRAP_CTO_RECOVERED" && e.roleKey === roleKey)).toBe(true);
      } finally { finish(); }
    });
  });

  it("rewakes only the recovered run and role, leaving another current owner's pending message alone", async () => {
    await withBootstrapRuntime(async f => {
      const { runId, ownerSessionId, roleKey, messageId } = await pendingRecovery(f);
      const other = await f.dispatchBootstrap();
      await f.awaitFinishedTurns(other.ownerSessionId, 1);
      const cp = f.harness.cp;
      const otherBefore = cp.outbox.listByRun(other.runId);
      f.harness.clock.advance(60_000);
      const wake = vi.spyOn(cp.sessionRuntime, "wake");
      f.claude.onWorkTurn = async (_request, credential) => {
        if (credential?.sessionId !== ownerSessionId) return;
        expect(await f.cto(ownerSessionId, "run_ack", { runId, messageId })).toMatchObject({ ok: true });
      };
      expect(await cp.bootstrapCtos.recover(roleKey)).toMatchObject({ allowed: true });
      await f.awaitFinishedTurns(ownerSessionId, 2);
      expect(wake.mock.calls.map(([role, triggers]) => [role, triggers.map(t => t.id)]))
        .toEqual([[roleKey, [messageId]], [roleKey, [messageId]]]);
      expect(cp.outbox.listByRun(other.runId)).toEqual(otherBefore);
      expect(cp.outbox.get(messageId)).toMatchObject({ status: "ACKED", bindingGeneration: 2 });
    });
  });

  it.each(["adopt", "attest", "restore", "stale-owner"])("does not rewake after %s failure", async failure => {
    await withBootstrapRuntime(async f => {
      const { roleKey } = await pendingRecovery(f);
      const cp = f.harness.cp;
      const rewake = vi.spyOn(cp.outbox, "wakeInBandPending");
      if (failure === "adopt") vi.spyOn(cp.sessionRuntime, "adopt").mockReturnValueOnce(deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "fixture"));
      if (failure === "attest") vi.spyOn(cp.sessionRuntime, "attest").mockResolvedValueOnce(deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "fixture"));
      if (failure === "restore") vi.spyOn(cp.runs, "restoreRecoveredBootstrapOwner").mockReturnValueOnce(deny(ReasonCode.RUN_OWNER_REVOKED, "fixture"));
      if (failure === "stale-owner") {
        const restore = cp.runs.restoreRecoveredBootstrapOwner.bind(cp.runs);
        vi.spyOn(cp.runs, "restoreRecoveredBootstrapOwner").mockImplementation((...args) => {
          const result = restore(...args);
          cp.db.run("UPDATE runs SET owner_binding_generation = 1 WHERE run_id = ?", [args[0]]);
          return result;
        });
      }
      expect(await cp.bootstrapCtos.recover(roleKey)).toMatchObject({ allowed: false });
      expect(rewake).not.toHaveBeenCalled();
    });
  });

  it("records a post-recovery wake failure separately from successful recovery", async () => {
    await withBootstrapRuntime(async f => {
      const { roleKey, ownerSessionId } = await pendingRecovery(f);
      const cp = f.harness.cp;
      const wake = cp.sessionRuntime.wake.bind(cp.sessionRuntime);
      vi.spyOn(cp.sessionRuntime, "wake").mockImplementation((...args) => cp.sessionRuntime.holds(ownerSessionId)
        ? deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "fixture post-recovery wake failure") : wake(...args));
      expect(await cp.bootstrapCtos.recover(roleKey)).toMatchObject({ allowed: true });
      const events = cp.audit.all();
      const recovered = events.find(e => e.kind === "BOOTSTRAP_CTO_RECOVERED" && e.roleKey === roleKey)!;
      const failedWake = events.find(e => e.kind === "OUTBOX_IN_BAND_WAKE_FAILED" && e.roleKey === roleKey && e.evidence["trigger"] === "rewake")!;
      expect(failedWake).toBeDefined();
      expect(failedWake.eventId).toBeGreaterThan(recovered.eventId);
      expect(events.filter(e => e.kind === "BOOTSTRAP_CTO_RECOVERY_REFUSED" && e.roleKey === roleKey)).toHaveLength(0);
    });
  });
});
