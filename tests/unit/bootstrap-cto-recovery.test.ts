import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS } from "../../src/run/bootstrap-cto-staffing.ts";
import {
  type BootstrapRuntimeFixture,
  type HeldCtoConnection,
  openHeldCtoConnection,
  withBootstrapRuntime,
} from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

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
  await vi.waitFor(() => expect(f.claude.turns).toHaveLength(2));
  f.loseClaude();
  await f.daemon.reconcileContinuity("claude coverage lost");
  expect(f.harness.cp.bindings.active(dispatched.roleKey)).toBeNull();
  expect(f.harness.cp.runs.require(dispatched.runId).state).toBe(RunState.BLOCKED);
  return dispatched;
};

describe("C1b: a revoked BOOTSTRAP_CTO is recovered on its own session, in the CEO's order", () => {
  it("outage → restore: probe, rotate (epoch+1, gen+1, same actor and session), deliver, attest, then ACTIVE and RUN_DISPATCH — every turn the same conversation in the same workdir", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await outage(f);
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
      // The recovered generation's RUN_DISPATCH starts a turn of the same conversation.
      await vi.waitFor(() => expect(f.claude.turns).toHaveLength(5));
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
      const { runId, ownerSessionId } = await outage(f);
      const previous = { ...f.claude.credentials.get(ownerSessionId)! };
      // Held open across the outage, as a relay that outlived its turn would be.
      f.restoreClaude();
      const opened = await openHeldCtoConnection(f.ctoSocket, previous);
      // The binding is revoked, so the old credential's connection holds no role yet.
      expect("refused" in opened).toBe(true);

      // A connection opened while generation 2's runtime is attesting would hold the role, so open
      // one with the *previous* secret just before the rotation commits.
      let early: HeldCtoConnection | { refused: Record<string, unknown> } | null = null;
      const rotate = f.harness.cp.sessions.rotateSecret.bind(f.harness.cp.sessions);
      vi.spyOn(f.harness.cp.sessions, "rotateSecret").mockImplementationOnce((sessionId, expectedEpoch) => rotate(sessionId, expectedEpoch));
      await f.daemon.reconcileContinuity("claude coverage returned");
      expect(f.harness.cp.runs.require(runId).ownerBindingGeneration).toBe(2);

      const current = f.claude.credentials.get(ownerSessionId)!;
      expect(current.sessionSecret).not.toBe(previous.sessionSecret);
      // The new credential works.
      const live = await openHeldCtoConnection(f.ctoSocket, current);
      expect("call" in live).toBe(true);
      const answered = await (live as HeldCtoConnection).call("role_dispatch_pending", {});
      expect(answered).toMatchObject({ ok: true });
      // The previous one is refused at the handshake.
      early = await openHeldCtoConnection(f.ctoSocket, previous);
      expect(early).toMatchObject({ refused: { ok: false, reasonCode: ReasonCode.SESSION_SECRET_INVALID } });

      // A connection that authenticated with the new credential at epoch 1 keeps working until the
      // next rotation; then its very next request is refused.
      const roleKey = f.harness.cp.runs.require(runId).ownerRoleKey!;
      f.loseClaude();
      await f.daemon.reconcileContinuity("claude coverage lost again");
      f.restoreClaude();
      f.harness.clock.advance(BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS + 1);
      await f.daemon.reconcileContinuity("claude coverage returned again");
      expect(f.harness.cp.bindings.active(roleKey)?.bindingGeneration).toBe(4);
      expect(f.harness.cp.sessions.require(ownerSessionId).credentialEpoch).toBe(2);
      const afterRotation = await (live as HeldCtoConnection).call("role_dispatch_pending", {});
      expect(afterRotation).toMatchObject({ ok: false, reasonCode: ReasonCode.SESSION_SECRET_INVALID });
      (live as HeldCtoConnection).close();
    });
  });

  it("a --resume probe alone never makes the run ACTIVE: the attestation is refused, so the run stays BLOCKED with no holder and no dispatch", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await outage(f);
      f.claude.presentAttestation = false;
      f.restoreClaude();
      const report = await f.daemon.reconcileContinuity("claude coverage returned");
      expect(report?.restorationDeferred).toContainEqual({ roleKey, reasonCode: ReasonCode.SESSION_NOT_READY });
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

describe("C1-02: continuity records no claim need for a bootstrap CTO", () => {
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
