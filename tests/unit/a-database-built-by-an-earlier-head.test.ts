import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { AuditLog } from "../../src/db/audit.ts";
import { ConversationTurnCoordinator } from "../../src/conversation/turn-coordinator.ts";
import { openDb } from "../../src/db/database.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The case neither a fresh install nor a replay can reach.
 *
 * Every other migration test builds the *current* DDL — a new database, or a v11 image replayed
 * forward through migrations that were themselves written against the current schema. Neither one
 * can hold a trigger whose body drifted under a head that has since been corrected, so an entire
 * class of defect was invisible to the suite: a migration that recreates a trigger set with
 * `CREATE TRIGGER IF NOT EXISTS` repairs only the ones it dropped first, and reports success.
 *
 * Measured on a database built by `132309a` and opened by the head this test was written for:
 * `user_version` became 25, `assertLoadBearingInvariants` passed, and then every settlement threw
 * `wrong number of arguments to function acp_turn_materialization_authorized()`. The turn stayed
 * IN_DOUBT, `adjudicate()` refused it for not being contradicted, and the actor's next claim was
 * refused because the first was unresolved — a conversation wedged with no exit, arriving through
 * the migration written to prevent exactly that.
 *
 * So this test does what the reviewer did: it puts a historical body into a database and requires
 * the migration to replace it.
 */
const NOW = "2026-08-22T00:00:00.000Z";

/** The settlement trigger exactly as `132309a` defined it — a four-argument marker call. */
const HISTORICAL_SETTLEMENT_TRIGGER = `
CREATE TRIGGER canonical_turns_settlement_authority
BEFORE UPDATE ON canonical_turns
WHEN (OLD.lifecycle_state IS NOT NEW.lifecycle_state
      OR OLD.outcome_kind IS NOT NEW.outcome_kind
      OR OLD.settled_at IS NOT NEW.settled_at
      OR OLD.resolution_authority IS NOT NEW.resolution_authority
      OR OLD.reason_code IS NOT NEW.reason_code
      OR OLD.evidence_digest IS NOT NEW.evidence_digest
      OR OLD.observation_consistency IS NOT NEW.observation_consistency)
  AND acp_turn_materialization_authorized(
        NEW.turn_request_id, NEW.outcome_kind, NEW.resolution_authority,
        NEW.observation_consistency) <> 1
BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED');
END`;

/** A private state directory, because the loader refuses a world-readable one. */
const stateDir = (): string => {
  const root = join(tempDir("acp-earlier-head-"), "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  return root;
};

/**
 * A database carrying an earlier head's trigger body, at the version that head left behind.
 *
 * Built by opening at the current version and then putting the drift back, rather than by
 * vendoring an entire historical schema: what matters is a trigger whose *body* is stale while
 * its name and its denial marker are the ones the registry expects, which is the shape that
 * walked past every check.
 */
const databaseWithHistoricalTrigger = (): string => {
  const path = join(stateDir(), "state.sqlite");
  openDb(path).close();

  const raw = new DatabaseSync(path);
  raw.exec("DROP TRIGGER canonical_turns_settlement_authority");
  raw.exec(HISTORICAL_SETTLEMENT_TRIGGER);
  // The receipt guards refuse this, correctly — they exist so a running system cannot rewrite its
  // own history. A fixture building a deliberately historical image is the one caller that has to
  // get past them, and it puts them back before the loader ever sees the file, so what is opened
  // is an ordinary v24 database rather than one missing its guards.
  raw.exec("DROP TRIGGER schema_migrations_no_delete");
  raw.exec("DELETE FROM schema_migrations WHERE version > 24");
  raw.exec(`CREATE TRIGGER schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END`);
  raw.exec("PRAGMA user_version = 24");
  raw.close();
  return path;
};

describe("a database whose trigger bodies came from an earlier head", () => {
  it("has its stale body replaced rather than kept, and can settle a turn afterwards", () => {
    const path = databaseWithHistoricalTrigger();

    const db = openDb(path);
    try {
      const stored = db.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='canonical_turns_settlement_authority'`,
      )!.sql;
      // The four-argument call is the whole tell. The one-argument marker is what the current
      // database registers, so a body still asking for four throws on every settlement.
      expect(stored).not.toContain("NEW.observation_consistency) <> 1");

      const clock = new ManualClock(NOW);
      const coordinator = new ConversationTurnCoordinator(db, clock, new AuditLog(db, clock));
      db.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
         VALUES ('s','i','claude','opus','READY',?,?)`,
        [NOW, NOW],
      );
      db.run(
        `INSERT INTO conversational_actors
           (actor_id, kind, current_session_id, current_session_incarnation, created_at)
         VALUES ('a','CEO','s','i',?)`,
        [NOW],
      );
      db.run(
        `INSERT INTO actor_target_bindings
           (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
         VALUES ('b','a','hermes','L','D',?)`,
        [NOW],
      );
      // The active role binding the attestation's generation names, so `claim()`'s currency check
      // (#666) has a current generation to find.
      db.run(
        `INSERT INTO assignments
           (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
            binding_generation, mode, status, created_at)
         VALUES ('asg:a','CEO:a','CEO','a','s','i',1,'PREFERRED','ACTIVE',?)`,
        [NOW],
      );
      db.run(
        `INSERT INTO actor_target_attestations
           (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
            executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
            attested_at)
         VALUES ('t','b','v1','AD','s','i',1,'asg:a',?)`,
        [NOW],
      );
      // `claim()` now requires ingress to have admitted the (channel, nonce) a source names, with
      // the same payload it names (#666) — so the fixture admits through the real path rather
      // than inserting the row by hand.
      const admitted = new IngressGuard(db, clock, new AuditLog(db, clock), {
        telegram: { allowedActors: ["owner"], allowedConversations: ["convo"] },
      }).admit({ channel: "telegram", actor: "owner", conversation: "convo", nonce: "m1", payload: {} });
      expect(admitted.allowed).toBe(true);

      const claimed = coordinator.claim({
        targetActorId: "a",
        prompt: "hi",
        sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: {} }],
      });
      expect(claimed.allowed).toBe(true);
      if (!claimed.allowed) return;

      const settled = coordinator.ports.target.completed(claimed.value, {
        receiptId: "r1",
        evidenceDigest: "sha256:e",
        reasonCode: "OK",
      });
      expect(settled.allowed).toBe(true);
      expect(
        db.get<{ lifecycle_state: string }>(
          `SELECT lifecycle_state FROM canonical_turns WHERE turn_request_id = ?`,
          [claimed.value.turnRequestId],
        )!.lifecycle_state,
      ).toBe("SETTLED");
    } finally {
      db.close();
    }
  });

  it("refuses to open when a load-bearing body was replaced, even with the right name and marker", () => {
    // The enabler underneath the above: the invariant check read a name and a denial-marker
    // substring, so a body gutted around a kept marker read as healthy. A stale body always keeps
    // its marker — that is why the substring could never have caught this.
    const path = join(stateDir(), "state.sqlite");
    openDb(path).close();

    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER canonical_turns_no_delete");
    raw.exec(
      `CREATE TRIGGER canonical_turns_no_delete BEFORE DELETE ON canonical_turns
       WHEN 0 BEGIN SELECT RAISE(ABORT, 'CANONICAL_TURN_NO_DELETE'); END`,
    );
    raw.close();

    expect(() => openDb(path)).toThrowError(
      /load-bearing trigger canonical_turns_no_delete does not have the body this schema defines/,
    );
  });
});
