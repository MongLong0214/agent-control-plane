import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { IN_BAND_REWAKE_MS } from "../../src/outbox/outbox.ts";
import { DRIVEN_PRIMARY_CTO_SPAWN_RECORD } from "../../src/runtime/provisioned-session-runtime.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import {
  DRIVEN_HANDOFF,
  actOnWorkTurns,
  countAudit,
  drivenPrimary,
  externalOf,
  holdNextAttestation,
  openActivationHandoff,
  routeInBandWakes,
  workTurnsOf,
} from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #246 PR-C C4-R2 — a driven PRIMARY_CTO is recovered on its own session and never replaced, its
 * spawns clean up only what they are proven to have created, and an attestation's failure is
 * scoped to the exact epoch it was for.
 *
 * Over the real sockets (`cto.mcp.sock`, the take-once launch channel) and the daemon's own
 * continuity reconcile; only the model is scripted (`HeadlessRuntimeDouble`).
 */

/** A project with a manifest and no repository: enough for its PRIMARY_CTO to be provisioned. */
const registerBareProjectFor = (f: BootstrapRuntimeFixture, projectId: string): void => {
  const manifest = fixtureManifest(projectId);
  const project = f.harness.cp.projects.register({
    projectId,
    name: projectId,
    manifest,
    authorization: f.harness.cp.manifestAuthorizationForTests(manifest),
  });
  if (!project.allowed) throw new Error(project.message);
};

const sessionCount = (f: BootstrapRuntimeFixture): number =>
  f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)!.n;

describe("#246 C4-R2 — an attestation's failure is scoped to the epoch it was for", () => {
  it("keeps a newer epoch's attestation when an earlier epoch's attestation fails late", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "late-failure");
      const held = holdNextAttestation(f, binding.sessionId);
      // Epoch N's attestation is out, inside the provider.
      const late = cp.sessionRuntime.attest(binding.sessionId, "resume");
      await vi.waitFor(() => expect(held.entered()).toBe(true));
      // The daemon drops its custody, and the session is given epoch N+1, adopted and attested.
      cp.sessionRuntime.release(binding.sessionId);
      const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
      const rotated = cp.sessions.rotateSecret(binding.sessionId, epoch);
      if (!rotated.allowed) throw new Error(rotated.message);
      expect(cp.sessionRuntime.adopt(binding.sessionId, Role.PRIMARY_CTO, rotated.value.sessionSecret, epoch + 1).allowed).toBe(true);
      expect((await cp.sessionRuntime.attest(binding.sessionId, "resume")).allowed).toBe(true);
      expect(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);

      // Epoch N's attestation now fails, late.
      held.release();
      expect((await late).allowed).toBe(false);
      // Its failure was for epoch N; epoch N+1's attestation stands and work is admitted.
      expect(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);
      expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "after-the-late-failure", kind: "test" }])).toMatchObject({
        allowed: true,
      });
      await vi.waitFor(() => expect(workTurnsOf(f, binding.sessionId)).toBe(1));
    });
  });
});

describe("#246 C4-R2 — a driven PRIMARY_CTO is recovered on its own session, and only it", () => {
  it("is recovered on its own session after a crash before it acknowledged its handoff, which is then delivered once", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { bootstrap, binding } = await drivenPrimary(f, "recover-crash");
      actOnWorkTurns(f, binding.sessionId);
      // The handoff is queued, and the daemon goes down before any turn acknowledged it: what it held
      // in memory for the session — the credential and its attestation — is gone.
      cp.outbox.attachInBandWake(async () => ({ allowed: true, reasonCode: ReasonCode.OK, value: undefined, evidence: {} }));
      const opened = openActivationHandoff(f)("recover-crash", bootstrap.runId, binding.sessionId, DRIVEN_HANDOFF);
      if (!opened.allowed) throw new Error(opened.message);
      const messageId = cp.outbox.byIdempotencyKey(`bootstrap-handoff:${opened.value.handoffId}`)!.messageId;
      cp.sessionRuntime.release(binding.sessionId);
      routeInBandWakes(f);
      const before = cp.sessions.require(binding.sessionId);
      const sessionsBefore = sessionCount(f);
      const startedBefore = f.claude.started.length;
      const turnsBefore = f.claude.turns.length;
      expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: messageId, kind: "in-band dispatch" }]).allowed).toBe(false);
      const adapterRoles = vi.spyOn(cp.providers, "requireForRole");

      const report = await f.daemon.reconcileContinuity("the daemon restarted");
      expect(report?.unresolved ?? []).not.toContainEqual(expect.objectContaining({ roleKey: binding.roleKey }));

      // Its own session, its own binding, the next credential epoch; nothing new was spawned or bound.
      const after = cp.sessions.require(binding.sessionId);
      expect(after).toMatchObject({ incarnation: before.incarnation, lifecycle: SessionLifecycle.READY });
      expect(after.credentialEpoch).toBe(before.credentialEpoch + 1);
      expect(cp.bindings.active(binding.roleKey)).toMatchObject({
        assignmentId: binding.assignmentId,
        sessionId: binding.sessionId,
        bindingGeneration: binding.bindingGeneration,
      });
      expect(sessionCount(f)).toBe(sessionsBefore);
      expect(f.claude.started.length).toBe(startedBefore);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
      // The probe was a real turn resuming the session's own conversation, with no credential.
      const recoveryTurns = f.claude.turns.slice(turnsBefore);
      expect(recoveryTurns[0]).toMatchObject({
        conversation: "resume",
        relay: null,
        handle: { externalSessionId: externalOf(f, binding.sessionId) },
      });
      expect(recoveryTurns[1]).toMatchObject({ conversation: "resume" });
      expect(recoveryTurns[1]!.prompt).toMatch(/session_attest/);
      // Every provider turn of the recovery ran on the PRIMARY_CTO's own role-scoped adapter.
      const claudeRoles = adapterRoles.mock.calls.filter(([provider]) => provider === "claude").map(([, role]) => role);
      expect(claudeRoles.length).toBeGreaterThan(0);
      expect(new Set(claudeRoles)).toEqual(new Set([Role.PRIMARY_CTO]));
      expect(countAudit(f, "PRIMARY_CTO_RECOVERED", binding.sessionId)).toBe(1);

      // The handoff waited PENDING under its outbox key and is delivered once by the outbox's re-wake.
      expect(cp.outbox.get(messageId)?.status).toBe("PENDING");
      f.harness.clock.advance(IN_BAND_REWAKE_MS + 1);
      const finished = f.finishedTurns(binding.sessionId);
      await cp.outbox.wakeInBandPending();
      await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId)).toBe(finished + 1), { timeout: 10_000 });
      expect(cp.outbox.get(messageId)?.status).toBe("ACKED");
      expect(cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [opened.value.handoffId])?.status)
        .toBe("ACKED");
      expect(countAudit(f, "HANDOFF_ACK", binding.sessionId)).toBe(1);
      expect(cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key = ?`,
        [`bootstrap-handoff:${opened.value.handoffId}`],
      )?.n).toBe(1);
    });
  });

  it("is refused, not replaced, when the provider no longer has its conversation", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "recover-lost-conversation");
      cp.sessionRuntime.release(binding.sessionId);
      // The provider has lost the conversation: a `--resume` of it fails.
      const session = cp.sessions.require(binding.sessionId);
      await f.claude.stopSession({
        externalSessionId: externalOf(f, binding.sessionId),
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        pid: null,
      });
      const sessionsBefore = sessionCount(f);
      const startedBefore = f.claude.started.length;

      const report = await f.daemon.reconcileContinuity("the daemon restarted");
      expect(report?.unresolved).toContainEqual({ roleKey: binding.roleKey, reasonCode: ReasonCode.SESSION_TURN_FAILED });
      expect(countAudit(f, "PRIMARY_CTO_RECOVERY_REFUSED", binding.sessionId)).toBe(1);
      // Nothing spawned or bound in its place; the binding, session and epoch are as they were.
      expect(sessionCount(f)).toBe(sessionsBefore);
      expect(f.claude.started.length).toBe(startedBefore);
      expect(cp.bindings.active(binding.roleKey)).toMatchObject({ assignmentId: binding.assignmentId, sessionId: binding.sessionId });
      expect(cp.sessions.require(binding.sessionId)).toMatchObject({
        lifecycle: SessionLifecycle.READY,
        credentialEpoch: session.credentialEpoch,
      });
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(false);
      // Continuity does not fail it over to another session either.
      expect(await cp.continuity.failover(binding.roleKey, Role.PRIMARY_CTO, { projectId: "recover-lost-conversation" }, "test"))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED });
      expect(sessionCount(f)).toBe(sessionsBefore);
      // The next pass waits out the backoff without spending a provider turn.
      const turns = f.claude.turns.length;
      const again = await f.daemon.reconcileContinuity("the next pass");
      expect(again?.unresolved).toContainEqual({ roleKey: binding.roleKey, reasonCode: ReasonCode.DAEMON_BACKOFF_ACTIVE });
      expect(f.claude.turns.length).toBe(turns);
    });
  });

  it("releases the new credential when the recovery's attestation fails, and recovers on the next pass after its backoff", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "attestation-refused");
      cp.sessionRuntime.release(binding.sessionId);
      const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
      f.claude.presentAttestation = false;
      const first = await f.daemon.reconcileContinuity("the daemon restarted");
      expect(first?.unresolved).toContainEqual({ roleKey: binding.roleKey, reasonCode: ReasonCode.SESSION_NOT_READY });
      // The rotated credential was never proven: the daemon holds nothing, so the next pass tries again.
      expect(cp.sessions.require(binding.sessionId).credentialEpoch).toBe(epoch + 1);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(false);
      f.claude.presentAttestation = true;
      f.harness.clock.advance(15 * 60_000 + 1);
      const second = await f.daemon.reconcileContinuity("the next pass");
      expect(second?.unresolved ?? []).not.toContainEqual(expect.objectContaining({ roleKey: binding.roleKey }));
      expect(cp.sessions.require(binding.sessionId).credentialEpoch).toBe(epoch + 2);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
      expect(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);
    });
  });

  it("leaves a healthy driven PRIMARY_CTO alone, by the daemon and when asked directly", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "healthy");
      const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
      const turns = f.claude.turns.length;
      const report = await f.daemon.reconcileContinuity("a routine pass");
      expect(report?.unresolved ?? []).not.toContainEqual(expect.objectContaining({ roleKey: binding.roleKey }));
      expect(await cp.cto.recoverDrivenPrimaryCto(binding.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime }))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
      expect(f.claude.turns.length).toBe(turns);
      expect(cp.sessions.require(binding.sessionId).credentialEpoch).toBe(epoch);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
      expect(countAudit(f, "PRIMARY_CTO_RECOVERY_REFUSED", binding.sessionId)).toBe(0);

      // Nor anything that is not a driven PRIMARY_CTO: an interactive one, or a run's bootstrap CTO.
      registerBareProjectFor(f, "interactive-other");
      const interactive = await cp.cto.ensurePrimaryCto("interactive-other", "cto_start");
      if (!interactive.allowed) throw new Error(interactive.message);
      const interactiveEpoch = cp.sessions.require(interactive.value.sessionId).credentialEpoch;
      expect(await cp.cto.recoverDrivenPrimaryCto(interactive.value.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime }))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
      expect(cp.sessions.require(interactive.value.sessionId).credentialEpoch).toBe(interactiveEpoch);
      const bootstrapRole = cp.db.get<{ role_key: string }>(
        `SELECT role_key FROM assignments WHERE role = 'BOOTSTRAP_CTO' AND status = 'ACTIVE' LIMIT 1`,
      )!.role_key;
      expect(await cp.cto.recoverDrivenPrimaryCto(bootstrapRole, { capacity: cp.capacity, runtime: cp.sessionRuntime }))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(f.claude.turns.length).toBe(turns);
    });
  });

  it("neither revokes nor replaces a driven PRIMARY_CTO when its provider's coverage is lost", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "coverage-lost");
      const sessionsBefore = sessionCount(f);
      f.loseClaude();
      f.harness.clock.advance(60 * 60_000);
      await f.daemon.reconcileContinuity("claude coverage lost");
      f.harness.clock.advance(60 * 60_000);
      await f.daemon.reconcileContinuity("claude coverage still lost");
      expect(cp.bindings.active(binding.roleKey)).toMatchObject({ assignmentId: binding.assignmentId, sessionId: binding.sessionId });
      expect(sessionCount(f)).toBe(sessionsBefore);
    });
  });

  it("refuses to rotate when the session's credential moved while it was being probed", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "moved-during-probe");
      cp.sessionRuntime.release(binding.sessionId);
      const external = externalOf(f, binding.sessionId);
      const original = f.claude.runSessionTurn.bind(f.claude);
      let moved = false;
      f.claude.runSessionTurn = async (request) => {
        // Inside the recovery's own `--resume` probe, someone else rotates the credential.
        if (!moved && request.handle.externalSessionId === external && request.relay === null) {
          moved = true;
          const rotated = cp.sessions.rotateSecret(binding.sessionId, cp.sessions.require(binding.sessionId).credentialEpoch);
          if (!rotated.allowed) throw new Error(rotated.message);
        }
        return original(request);
      };
      const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
      const recovered = await cp.cto.recoverDrivenPrimaryCto(binding.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime });
      expect(moved).toBe(true);
      expect(recovered).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE });
      // Only the other rotation happened; the recovery adopted nothing and attested nothing.
      expect(cp.sessions.require(binding.sessionId).credentialEpoch).toBe(epoch + 1);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(false);
      expect(countAudit(f, "PRIMARY_CTO_RECOVERED", binding.sessionId)).toBe(0);
    });
  });

  it("refuses to rotate when the binding was revoked while the session was being probed", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "revoked-during-probe");
      cp.sessionRuntime.release(binding.sessionId);
      const external = externalOf(f, binding.sessionId);
      const original = f.claude.runSessionTurn.bind(f.claude);
      let revoked = false;
      f.claude.runSessionTurn = async (request) => {
        if (!revoked && request.handle.externalSessionId === external && request.relay === null) {
          revoked = true;
          expect(cp.bindings.revoke(binding.roleKey, "fixture: released while the recovery probed").allowed).toBe(true);
        }
        return original(request);
      };
      const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
      const recovered = await cp.cto.recoverDrivenPrimaryCto(binding.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime });
      expect(revoked).toBe(true);
      expect(recovered.allowed).toBe(false);
      expect(cp.sessions.require(binding.sessionId).credentialEpoch).toBe(epoch);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(false);
      expect(countAudit(f, "PRIMARY_CTO_RECOVERED", binding.sessionId)).toBe(0);
    });
  });
});

const CLEANUP = "PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP";

const cleanupOutcomes = (f: BootstrapRuntimeFixture, sessionId: string): string[] =>
  f.harness.cp.db.all<{ outcome: string }>(
    `SELECT json_extract(evidence_json, '$.outcome') AS outcome FROM audit_events
      WHERE kind = ? AND session_id = ? ORDER BY event_id`,
    [CLEANUP, sessionId],
  ).map((row) => row.outcome);

/** The session a project's driven spawn created, read from its spawn record. */
const spawnedSession = (f: BootstrapRuntimeFixture, projectId: string): string =>
  f.harness.cp.db.get<{ session_id: string }>(
    `SELECT session_id FROM audit_events WHERE kind = ? AND project_id = ? ORDER BY event_id DESC LIMIT 1`,
    [DRIVEN_PRIMARY_CTO_SPAWN_RECORD, projectId],
  )!.session_id;

/** Provisions a driven PRIMARY_CTO, running `interpose` at its readiness check: after READY, before the bind. */
const provisionAround = async (
  f: BootstrapRuntimeFixture,
  projectId: string,
  interpose: (sessionId: string) => void,
) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId);
  const bootstrap = await f.dispatchBootstrap();
  const readiness = cp.doctor.sessionReadiness.bind(cp.doctor);
  vi.spyOn(cp.doctor, "sessionReadiness").mockImplementationOnce(async (sessionId: string) => {
    interpose(sessionId);
    return readiness(sessionId);
  });
  const result = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  return { result, sessionId: spawnedSession(f, projectId), roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }) };
};

describe("#246 C4-R2 — a driven spawn cleans up only what it created", () => {
  it("stops the session of a refused spawn at the provider", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, "refused-spawn");
      const bootstrap = await f.dispatchBootstrap();
      f.claude.presentAttestation = false;
      const refused = await cp.cto.ensureDrivenPrimaryCto("refused-spawn", bootstrap.runId);
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      const loser = spawnedSession(f, "refused-spawn");
      expect(f.claude.stopped).toEqual([externalOf(f, loser)]);
      expect(cp.sessions.require(loser).lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(cleanupOutcomes(f, loser)).toEqual(["STOPPED"]);
    });
  });

  it("stops the spawn that lost the race and leaves the winner untouched", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const winner = cp.sessions.create({ provider: "scripted", model: "winner-cto" });
      cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, "fixture: the winner");
      const scriptedStops = vi.spyOn(f.harness.scripted, "stopSession");
      const { result, sessionId: loser, roleKey } = await provisionAround(f, "lost-race", () => {
        const won = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "lost-race", sessionId: winner.sessionId });
        if (!won.allowed) throw new Error(won.message);
      });
      expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE });
      // The loser, and only the loser, is stopped at the provider and recorded so.
      expect(f.claude.stopped).toEqual([externalOf(f, loser)]);
      expect(cp.sessions.require(loser).lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(cp.sessionRuntime.holds(loser)).toBe(false);
      expect(cleanupOutcomes(f, loser)).toEqual(["STOPPED"]);
      // The winner keeps its binding, its READY session and every resource it has.
      expect(cp.bindings.active(roleKey)).toMatchObject({ sessionId: winner.sessionId });
      expect(cp.sessions.require(winner.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(scriptedStops).not.toHaveBeenCalled();
      expect(cleanupOutcomes(f, winner.sessionId)).toEqual([]);
    });
  });

  it("records a failed stop as remaining, never as cleaned up", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const winner = cp.sessions.create({ provider: "scripted", model: "winner-cto" });
      cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, "fixture: the winner");
      vi.spyOn(f.claude, "stopSession").mockRejectedValueOnce(new Error("provider stop failed"));
      const { result, sessionId: loser } = await provisionAround(f, "stop-failed", () => {
        const won = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "stop-failed", sessionId: winner.sessionId });
        if (!won.allowed) throw new Error(won.message);
      });
      expect(result.allowed).toBe(false);
      expect(cleanupOutcomes(f, loser)).toEqual(["REMAINING_STOP_FAILED"]);
      expect(cp.sessions.require(loser).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(countAudit(f, "CTO_UNUSED_SESSION_STOP_FAILED", loser)).toBe(1);
    });
  });

  it("records a failed stop of a refused spawn as remaining as well", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, "refused-stop-failed");
      const bootstrap = await f.dispatchBootstrap();
      f.claude.presentAttestation = false;
      vi.spyOn(f.claude, "stopSession").mockRejectedValueOnce(new Error("provider stop failed"));
      expect((await cp.cto.ensureDrivenPrimaryCto("refused-stop-failed", bootstrap.runId)).allowed).toBe(false);
      const loser = spawnedSession(f, "refused-stop-failed");
      expect(cleanupOutcomes(f, loser)).toEqual(["REMAINING_STOP_FAILED"]);
      expect(cp.sessions.require(loser).lifecycle).toBe(SessionLifecycle.ERROR);
    });
  });

  it("stops nothing whose ownership it cannot prove, and records it as remaining", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      // The spawning session itself comes to hold the role before the bind: it is now a holder.
      const { result, sessionId: spawned, roleKey } = await provisionAround(f, "unverified", (sessionId) => {
        const held = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "unverified", sessionId });
        if (!held.allowed) throw new Error(held.message);
      });
      expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE });
      expect(cleanupOutcomes(f, spawned)).toEqual(["REMAINING_OWNERSHIP_UNVERIFIED"]);
      expect(f.claude.stopped).toEqual([]);
      expect(cp.sessions.require(spawned).lifecycle).toBe(SessionLifecycle.READY);
      expect(cp.bindings.active(roleKey)).toMatchObject({ sessionId: spawned });
    });
  });

  it("stops nothing when the spawned session carries a second spawn record, and records it as remaining", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { result, sessionId: spawned } = await provisionAround(f, "two-records", (sessionId) => {
        cp.audit.record({
          kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
          projectId: "two-records",
          roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: "two-records" }),
          sessionId,
          evidence: { creationGeneration: 1 },
        });
      });
      expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
      expect(cleanupOutcomes(f, spawned)).toEqual(["REMAINING_OWNERSHIP_UNVERIFIED"]);
      expect(f.claude.stopped).toEqual([]);
    });
  });
});
