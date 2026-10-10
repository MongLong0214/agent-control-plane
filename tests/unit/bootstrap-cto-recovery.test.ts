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
  await vi.waitFor(() => expect(f.finishedTurns(dispatched.ownerSessionId)).toBe(2));
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
      await vi.waitFor(() => expect(f.claude.turns).toHaveLength(5));
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
        { conversation: "new", relay: true, externalSessionId: conversation, workdir: before.workdir, attestation: true },
        { conversation: "resume", relay: true, externalSessionId: conversation, workdir: before.workdir, attestation: false },
        // The recovery: a probe with no relay and no credential, then the attestation with the new one.
        { conversation: "resume", relay: false, externalSessionId: conversation, workdir: before.workdir, attestation: false },
        { conversation: "resume", relay: true, externalSessionId: conversation, workdir: before.workdir, attestation: true },
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

  it("a --resume probe alone never makes the run ACTIVE: the attestation is refused, so the run stays BLOCKED with no holder and no dispatch", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await outage(f);
      f.claude.presentAttestation = false;
      f.restoreClaude();
      const report = await f.daemon.reconcileContinuity("claude coverage returned");
      expect(report?.restorationDeferred).toContainEqual({ roleKey, reasonCode: ReasonCode.SESSION_ATTESTATION_FAILED });
      // The probe ran and answered.
      expect(f.claude.turns.at(-2)).toMatchObject({ conversation: "resume", relay: null });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, ownerBindingGeneration: 1 });
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      expect(runDispatches(f, runId).filter((message) => message.bindingGeneration !== 1)).toEqual([]);
      expect(f.harness.cp.sessions.require(ownerSessionId).lifecycle).toBe(SessionLifecycle.READY);
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
    {
      name: "delivery refused (the relay never takes the new credential)",
      arrange: (f) => {
        f.claude.takeCredential = false;
      },
      generations: 2,
      epoch: 1,
    },
    {
      name: "authentication refused (the relay presents the previous credential)",
      arrange: (f) => {
        f.claude.presentStaleCredential = true;
      },
      generations: 2,
      epoch: 1,
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
      f.claude.takeCredential = false;
      f.restoreClaude();
      await f.daemon.reconcileContinuity("claude coverage returned");
      const turns = f.claude.turns.length;

      f.claude.takeCredential = true;
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
      const { runId, roleKey } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.claude.turns).toHaveLength(2));
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
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
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
