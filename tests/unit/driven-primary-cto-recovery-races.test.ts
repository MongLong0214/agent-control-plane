import { afterAll, afterEach, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary, externalOf, holdNextAttestation } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";

/**
 * #246 PR-C C4-R2 — the races review 1 of the recovery slice found, kept as repository witnesses.
 * Each is the review's reproduction with only its harness adapted (no review-tree paths); R1-02's
 * concurrent bind is now expected to be refused, which is the fix it asked for (see that witness).
 * The review's real-subprocess resume witness is not kept: its sandboxed child process writes its
 * scratch under the operator's home, which no repository test may do.
 */

// ACP's transient files stay in this run's temporary tree, never under the operator's home.
vi.mock("../../src/core/scratch-root.ts", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = path.join(os.tmpdir(), "acp-c4r2-races-scratch");
  return {
    ACP_SCRATCH_ROOT: root,
    acpScratchDir: (prefix: string) => {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      return fs.mkdtempSync(path.join(root, prefix));
    },
  };
});

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

it("1084-R1-01: late recovery failure must retain the newer credential and attestation", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const { binding } = await drivenPrimary(f, "review-late-recovery");
    cp.sessionRuntime.release(binding.sessionId);
    const held = holdNextAttestation(f, binding.sessionId);
    const late = cp.cto.recoverDrivenPrimaryCto(binding.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime });
    await vi.waitFor(() => expect(held.entered()).toBe(true));
    cp.sessionRuntime.release(binding.sessionId);
    const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
    const rotated = cp.sessions.rotateSecret(binding.sessionId, epoch);
    if (!rotated.allowed) throw new Error(rotated.message);
    expect(cp.sessionRuntime.adopt(binding.sessionId, Role.PRIMARY_CTO, rotated.value.sessionSecret, epoch + 1).allowed).toBe(true);
    expect((await cp.sessionRuntime.attest(binding.sessionId, "resume")).allowed).toBe(true);
    expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
    expect(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);
    held.release();
    expect((await late).allowed).toBe(false);
    expect.soft(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
    expect.soft(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);
  });
});

/**
 * The review's reproduction let the concurrent winner relinquish and bind the cleanup target while
 * its stop was pending, then expected cleanup not to stop it. Its harness calls the provider stop
 * itself after that bind, so no product behaviour could make it pass; the fix it asked for is that
 * the target cannot be adopted once its cleanup has proven ownership. So the same race is driven
 * here, and what is asserted is that closure: the target is out of READY when its stop begins, the
 * concurrent bind of it is refused, and no ACTIVE assignment is left on a stopped session.
 */
it("1084-R1-02: cleanup must exclude a session that becomes a holder while stop is pending", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
    await registerFixtureProject(f.harness, "review-stop-race");
    const bootstrap = await f.dispatchBootstrap();
    const winner = cp.sessions.create({ provider: "scripted", model: "winner" });
    cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, "fixture");
    let spawned = "";
    const readiness = cp.doctor.sessionReadiness.bind(cp.doctor);
    vi.spyOn(cp.doctor, "sessionReadiness").mockImplementationOnce(async (id) => {
      spawned = id;
      const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "review-stop-race", sessionId: winner.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      return readiness(id);
    });
    const roleKey = "PRIMARY_CTO:review-stop-race";
    const stop = f.claude.stopSession.bind(f.claude);
    let lifecycleAtStop: string | null = null;
    let bindDuringStop: boolean | null = null;
    vi.spyOn(f.claude, "stopSession").mockImplementationOnce(async (handle) => {
      lifecycleAtStop = cp.sessions.require(spawned).lifecycle;
      expect(cp.bindings.revoke(roleKey, "fixture concurrent winner relinquishes").allowed).toBe(true);
      bindDuringStop = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "review-stop-race", sessionId: spawned }).allowed;
      await stop(handle);
    });
    expect((await cp.cto.ensureDrivenPrimaryCto("review-stop-race", bootstrap.runId)).allowed).toBe(false);
    expect(lifecycleAtStop).not.toBe(SessionLifecycle.READY);
    expect(bindDuringStop).toBe(false);
    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments a JOIN sessions s ON s.session_id = a.session_id
        WHERE a.status = 'ACTIVE' AND s.lifecycle = 'STOPPED'`,
    )?.n).toBe(0);
    // The winner was never stopped: the one stop that ran was the cleanup target's.
    expect(f.claude.stopped).toEqual([externalOf(f, spawned)]);
  });
});

it("1084-R1-03: a changed binding during probe must not authorize rotation of the old session", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const { binding: old, bootstrap } = await drivenPrimary(f, "review-binding-old");
    const manifest = fixtureManifest("review-binding-other");
    const registered = cp.projects.register({ projectId: "review-binding-other", name: "other", manifest, authorization: cp.manifestAuthorizationForTests(manifest) });
    if (!registered.allowed) throw new Error(registered.message);
    const otherResult = await cp.cto.ensureDrivenPrimaryCto("review-binding-other", bootstrap.runId);
    if (!otherResult.allowed) throw new Error(otherResult.message);
    const other = otherResult.value;
    cp.sessionRuntime.release(old.sessionId);
    cp.sessionRuntime.release(other.sessionId);
    const before = cp.sessions.require(old.sessionId).credentialEpoch;
    const original = f.claude.runSessionTurn.bind(f.claude);
    let moved = false;
    f.claude.runSessionTurn = async (request) => {
      if (!moved && request.handle.externalSessionId === externalOf(f, old.sessionId) && request.relay === null) {
        moved = true;
        const changed = cp.bindings.switchTo({ roleKey: old.roleKey, role: Role.PRIMARY_CTO, projectId: old.projectId,
          sessionId: other.sessionId, mode: "PREFERRED", reason: "fixture concurrent bind", conversation: "SURVIVED" });
        if (!changed.allowed) throw new Error(changed.message);
        expect(cp.bindings.active(old.roleKey)?.sessionId).toBe(other.sessionId);
      }
      return original(request);
    };
    const recovered = await cp.cto.recoverDrivenPrimaryCto(old.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime });
    expect(moved).toBe(true);
    expect(recovered.allowed).toBe(false);
    expect(cp.sessions.require(old.sessionId).credentialEpoch).toBe(before);
  });
});

it("1084-R1-03 (replaced binding): a newer driven binding for the role during the probe refuses rotation", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const { binding: old, bootstrap } = await drivenPrimary(f, "review-binding-replaced");
    cp.sessionRuntime.release(old.sessionId);
    const before = cp.sessions.require(old.sessionId).credentialEpoch;
    const original = f.claude.runSessionTurn.bind(f.claude);
    let replacement = "";
    let replacementEpoch = -1;
    f.claude.runSessionTurn = async (request) => {
      if (!replacement && request.handle.externalSessionId === externalOf(f, old.sessionId) && request.relay === null) {
        // During the old session's probe the role is released and given to a new driven session.
        expect(cp.bindings.revoke(old.roleKey, "fixture released during the probe").allowed).toBe(true);
        replacement = "pending";
        const won = await cp.cto.ensureDrivenPrimaryCto("review-binding-replaced", bootstrap.runId);
        if (!won.allowed) throw new Error(won.message);
        replacement = won.value.sessionId;
        cp.sessionRuntime.release(replacement);
        replacementEpoch = cp.sessions.require(replacement).credentialEpoch;
      }
      return original(request);
    };
    const recovered = await cp.cto.recoverDrivenPrimaryCto(old.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime });
    expect(recovered).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    expect(cp.sessions.require(old.sessionId).credentialEpoch).toBe(before);
    expect(cp.sessions.require(replacement).credentialEpoch).toBe(replacementEpoch);
  });
});

it("1084-R1-03 (record of another role): recovery does not start on a session whose spawn record is another role's", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const { binding: old, bootstrap } = await drivenPrimary(f, "review-record-old");
    const manifest = fixtureManifest("review-record-other");
    const registered = cp.projects.register({ projectId: "review-record-other", name: "other", manifest, authorization: cp.manifestAuthorizationForTests(manifest) });
    if (!registered.allowed) throw new Error(registered.message);
    const otherResult = await cp.cto.ensureDrivenPrimaryCto("review-record-other", bootstrap.runId);
    if (!otherResult.allowed) throw new Error(otherResult.message);
    const other = otherResult.value;
    // Before any recovery, the old role's actor moves to the other project's driven session.
    const changed = cp.bindings.switchTo({ roleKey: old.roleKey, role: Role.PRIMARY_CTO, projectId: old.projectId,
      sessionId: other.sessionId, mode: "PREFERRED", reason: "fixture survived move", conversation: "SURVIVED" });
    if (!changed.allowed) throw new Error(changed.message);
    cp.sessionRuntime.release(other.sessionId);
    const otherEpoch = cp.sessions.require(other.sessionId).credentialEpoch;
    const turns = f.claude.turns.length;
    const recovered = await cp.cto.recoverDrivenPrimaryCto(old.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime });
    expect(recovered).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(cp.sessions.require(other.sessionId).credentialEpoch).toBe(otherEpoch);
    expect(f.claude.turns.length).toBe(turns);
  });
});

it("1084-R1-05: stop failure after session-row creation fails must record the remaining resource", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
    await registerFixtureProject(f.harness, "review-row-failure");
    const bootstrap = await f.dispatchBootstrap();
    const before = f.claude.started.length;
    vi.spyOn(cp.sessions, "createWithPinnedStart").mockImplementationOnce(() => { throw new Error("fixture session-row write failure"); });
    const stop = vi.spyOn(f.claude, "stopSession").mockRejectedValueOnce(new Error("fixture provider stop failure"));
    await expect(cp.cto.ensureDrivenPrimaryCto("review-row-failure", bootstrap.runId)).rejects.toThrow("fixture session-row write failure");
    expect(f.claude.started.length).toBe(before + 1);
    expect(stop).toHaveBeenCalledTimes(1);
    const records = cp.db.all<{ outcome: string }>(
      "SELECT json_extract(evidence_json, '$.outcome') AS outcome FROM audit_events WHERE kind = 'PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP' AND run_id = ?", [bootstrap.runId]);
    expect(records.map((r) => r.outcome)).toContain("REMAINING_STOP_FAILED");
  });
});

it("1084-R1-05 (record failure): a cleanup record that cannot be written is thrown, never passed over", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
    await registerFixtureProject(f.harness, "review-record-failure");
    const bootstrap = await f.dispatchBootstrap();
    vi.spyOn(cp.sessions, "createWithPinnedStart").mockImplementationOnce(() => { throw new Error("fixture session-row write failure"); });
    vi.spyOn(f.claude, "stopSession").mockRejectedValueOnce(new Error("fixture provider stop failure"));
    const record = cp.audit.record.bind(cp.audit);
    vi.spyOn(cp.audit, "record").mockImplementation((entry) =>
      entry.kind === "PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP"
        ? { allowed: false, reasonCode: ReasonCode.INTERNAL_ERROR, message: "fixture audit write failure", evidence: {} }
        : record(entry));
    await expect(cp.cto.ensureDrivenPrimaryCto("review-record-failure", bootstrap.runId))
      .rejects.toThrow(/REMAINING_STOP_FAILED and could not be recorded/);
  });
});
