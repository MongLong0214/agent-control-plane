import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { isStalenessReasonCode, ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const tableCount = (sql: string, harness: ReturnType<typeof makeHarness>): number =>
  harness.cp.db.get<{ count: number }>(sql)?.count ?? -1;

const forbiddenEffectCounts = (harness: ReturnType<typeof makeHarness>) => ({
  assignments: tableCount("SELECT COUNT(*) AS count FROM assignments", harness),
  auditEvents: tableCount("SELECT COUNT(*) AS count FROM audit_events", harness),
  outbox: tableCount("SELECT COUNT(*) AS count FROM outbox", harness),
  sessions: tableCount("SELECT COUNT(*) AS count FROM sessions", harness),
  bridgeMessages: harness.buzz.sent.length,
  providerInvocations: harness.scripted.invocations.length,
});

describe("conversational actor registration authority (L5)", () => {
  it("registers an existing detached actor and returns it from the dynamic active set with zero route effects", () => {
    const harness = makeHarness();
    const actorId = "actor:repo-factory";
    harness.cp.db.run(
      `INSERT INTO conversational_actors (actor_id, kind, created_at)
       VALUES (?, 'PRIMARY_CTO', ?)`,
      [actorId, harness.clock.nowIso()],
    );
    const before = forbiddenEffectCounts(harness);

    const registered = harness.cp.actors.register({
      actorId,
      actorGeneration: 1,
      expectedRegistrySetGeneration: 0,
    });

    expect(registered).toMatchObject({
      allowed: true,
      reasonCode: ReasonCode.OK,
      value: {
        actorId,
        actorGeneration: 1,
        registrationState: "REGISTERED",
        registrySetGeneration: 1,
      },
    });
    expect(harness.cp.actors.activeSet()).toEqual({
      registrySetGeneration: 1,
      actors: [{
        actorId,
        actorGeneration: 1,
        kind: "PRIMARY_CTO",
        registrationState: "REGISTERED",
        attachmentState: "DETACHED",
        currentSessionId: null,
        currentSessionIncarnation: null,
      }],
    });
    expect(forbiddenEffectCounts(harness)).toEqual(before);
  });

  it("rejects a stale expected set generation with re-derive semantics and no writes", () => {
    const harness = makeHarness();
    for (const actorId of ["actor:first-cto", "actor:second-cto"]) {
      harness.cp.db.run(
        `INSERT INTO conversational_actors (actor_id, kind, created_at)
         VALUES (?, 'PRIMARY_CTO', ?)`,
        [actorId, harness.clock.nowIso()],
      );
    }
    const first = harness.cp.actors.register({
      actorId: "actor:first-cto",
      actorGeneration: 1,
      expectedRegistrySetGeneration: 0,
    });
    expect(first.allowed).toBe(true);
    const before = harness.cp.actors.activeSet();

    const stale = harness.cp.actors.register({
      actorId: "actor:second-cto",
      actorGeneration: 1,
      expectedRegistrySetGeneration: 0,
    });

    expect(stale).toEqual({
      allowed: false,
      reasonCode: ReasonCode.REGISTERED_SET_GENERATION_MISMATCH,
      message: "the registered actor set changed before registration",
      evidence: {
        expectedRegistrySetGeneration: 0,
        observedRegistrySetGeneration: 1,
      },
    });
    expect(isStalenessReasonCode(stale.reasonCode)).toBe(true);
    expect(harness.cp.actors.activeSet()).toEqual(before);
  });

  it("unregisters the exact active actor generation and advances the set once", () => {
    const harness = makeHarness();
    const actorId = "actor:rotating-cto";
    harness.cp.db.run(
      `INSERT INTO conversational_actors (actor_id, kind, created_at)
       VALUES (?, 'PRIMARY_CTO', ?)`,
      [actorId, harness.clock.nowIso()],
    );
    expect(harness.cp.actors.register({
      actorId,
      actorGeneration: 4,
      expectedRegistrySetGeneration: 0,
    }).allowed).toBe(true);
    const beforeEffects = forbiddenEffectCounts(harness);

    const unregistered = harness.cp.actors.unregister({
      actorId,
      actorGeneration: 4,
      expectedRegistrySetGeneration: 1,
      reason: "owner-authorized rotation",
    });

    expect(unregistered).toMatchObject({
      allowed: true,
      reasonCode: ReasonCode.OK,
      value: {
        actorId,
        actorGeneration: 4,
        registrationState: "RETIRED",
        registrySetGeneration: 2,
      },
    });
    expect(harness.cp.actors.activeSet()).toEqual({ registrySetGeneration: 2, actors: [] });
    expect(harness.cp.db.get<{ registration_state: string; retired_reason: string }>(
      `SELECT registration_state, retired_reason
         FROM conversational_actor_registrations
        WHERE actor_id = ? AND actor_generation = ?`,
      [actorId, 4],
    )).toEqual({ registration_state: "RETIRED", retired_reason: "owner-authorized rotation" });
    expect(forbiddenEffectCounts(harness)).toEqual(beforeEffects);
  });

  it("fails duplicate, unknown, wrong-generation, and stale targets closed without changing the set", () => {
    const harness = makeHarness();
    const actorId = "actor:fail-closed-cto";
    harness.cp.db.run(
      `INSERT INTO conversational_actors (actor_id, kind, created_at)
       VALUES (?, 'PRIMARY_CTO', ?)`,
      [actorId, harness.clock.nowIso()],
    );
    expect(harness.cp.actors.register({
      actorId,
      actorGeneration: 3,
      expectedRegistrySetGeneration: 0,
    }).allowed).toBe(true);
    const before = harness.cp.actors.activeSet();

    const duplicate = harness.cp.actors.register({
      actorId,
      actorGeneration: 3,
      expectedRegistrySetGeneration: 1,
    });
    const unknown = harness.cp.actors.register({
      actorId: "actor:not-first-class",
      actorGeneration: 1,
      expectedRegistrySetGeneration: 1,
    });
    const wrongGeneration = harness.cp.actors.unregister({
      actorId,
      actorGeneration: 2,
      expectedRegistrySetGeneration: 1,
      reason: "wrong target must not retire",
    });
    const stale = harness.cp.actors.unregister({
      actorId,
      actorGeneration: 3,
      expectedRegistrySetGeneration: 0,
      reason: "stale caller must re-derive",
    });

    expect(duplicate).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(unknown).toMatchObject({ allowed: false, reasonCode: ReasonCode.NOT_FOUND });
    expect(wrongGeneration).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CONFLICT,
      evidence: { actorGeneration: 2, observedActorGeneration: 3 },
    });
    expect(stale).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.REGISTERED_SET_GENERATION_MISMATCH,
      evidence: { expectedRegistrySetGeneration: 0, observedRegistrySetGeneration: 1 },
    });
    expect(harness.cp.actors.activeSet()).toEqual(before);
  });

  it("enumerates multiple CTO actors once and permits only higher-generation rotation", () => {
    const harness = makeHarness();
    harness.cp.db.run(
      `INSERT INTO sessions
         (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES ('session:attached', 'inc-9', 'scripted', 'scripted-cto', 'READY', ?, ?)`,
      [harness.clock.nowIso(), harness.clock.nowIso()],
    );
    harness.cp.db.run(
      `INSERT INTO conversational_actors
         (actor_id, kind, current_session_id, current_session_incarnation, created_at)
       VALUES ('actor:a-cto', 'PRIMARY_CTO', 'session:attached', 'inc-9', ?),
              ('actor:b-cto', 'PRIMARY_CTO', NULL, NULL, ?)`,
      [harness.clock.nowIso(), harness.clock.nowIso()],
    );
    expect(harness.cp.actors.register({
      actorId: "actor:a-cto",
      actorGeneration: 8,
      expectedRegistrySetGeneration: 0,
    }).allowed).toBe(true);
    expect(harness.cp.actors.register({
      actorId: "actor:b-cto",
      actorGeneration: 2,
      expectedRegistrySetGeneration: 1,
    }).allowed).toBe(true);
    expect(harness.cp.actors.unregister({
      actorId: "actor:a-cto",
      actorGeneration: 8,
      expectedRegistrySetGeneration: 2,
      reason: "rotate actor generation",
    }).allowed).toBe(true);
    const nonMonotonic = harness.cp.actors.register({
      actorId: "actor:a-cto",
      actorGeneration: 8,
      expectedRegistrySetGeneration: 3,
    });
    expect(nonMonotonic).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(harness.cp.actors.register({
      actorId: "actor:a-cto",
      actorGeneration: 9,
      expectedRegistrySetGeneration: 3,
    }).allowed).toBe(true);

    expect(harness.cp.actors.activeSet()).toEqual({
      registrySetGeneration: 4,
      actors: [
        {
          actorId: "actor:a-cto",
          actorGeneration: 9,
          kind: "PRIMARY_CTO",
          registrationState: "REGISTERED",
          attachmentState: "ATTACHED",
          currentSessionId: "session:attached",
          currentSessionIncarnation: "inc-9",
        },
        {
          actorId: "actor:b-cto",
          actorGeneration: 2,
          kind: "PRIMARY_CTO",
          registrationState: "REGISTERED",
          attachmentState: "DETACHED",
          currentSessionId: null,
          currentSessionIncarnation: null,
        },
      ],
    });
  });

  it("rolls back membership when the set-generation write fails after registration insert", () => {
    const harness = makeHarness();
    const actorId = "actor:rollback-cto";
    harness.cp.db.run(
      `INSERT INTO conversational_actors (actor_id, kind, created_at)
       VALUES (?, 'PRIMARY_CTO', ?)`,
      [actorId, harness.clock.nowIso()],
    );
    const raw = new Database(harness.cp.db.file);
    try {
      raw.exec(`
        CREATE TRIGGER fail_actor_registry_generation
        BEFORE UPDATE ON conversational_actor_registry_state
        BEGIN
          SELECT RAISE(ABORT, 'INJECTED_REGISTRY_GENERATION_FAILURE');
        END;
      `);
    } finally {
      raw.close();
    }

    expect(() => harness.cp.actors.register({
      actorId,
      actorGeneration: 1,
      expectedRegistrySetGeneration: 0,
    })).toThrow(/INJECTED_REGISTRY_GENERATION_FAILURE/);
    expect(harness.cp.actors.activeSet()).toEqual({ registrySetGeneration: 0, actors: [] });
    expect(tableCount("SELECT COUNT(*) AS count FROM conversational_actor_registrations", harness)).toBe(0);
  });
});
