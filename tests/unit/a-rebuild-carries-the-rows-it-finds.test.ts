import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";

import { rebuildCanonicalTurnsIfStale, schemaDdl } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The half of a table rebuild no migration test was exercising.
 *
 * Three migrations rebuild a ledger table, and each copies rows from the old table into the new one
 * through a hand-written column list. `rebuildCanonicalTurnsIfStale` omitted four NOT NULL columns
 * — `executor_session_id`, `executor_session_incarnation`, `binding_generation`,
 * `claim_audit_event_id` — so the copy would have failed on any database holding a single turn.
 *
 * Every existing migration test passed, because **every test database is empty when a migration
 * runs**: a fresh install applies schema.sql whole and copies nothing, and the v11 fixture predates
 * these tables. So the check that would have caught it is not "did the migration run" but "did it
 * carry a row", and nothing asked that. Found by an independent review.
 *
 * The column list is derived from `pragma_table_info` now. This test is what makes that derivation
 * load-bearing rather than tidier.
 */
const V27_CANONICAL_TURNS_CHECK =
  "    OR (outcome_kind = 'ABORTED'\n" +
  "        AND resolution_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE',\n" +
  "                                     'OPERATOR_AFTER_REVIEW'))))";

/** The table as v27 defined it: the same shape, without the authority v28 admits. */
const previousShape = (): string => {
  const current = /CREATE TABLE IF NOT EXISTS canonical_turns \([\s\S]*?\n\);/.exec(schemaDdl());
  if (current === null) throw new Error("canonical_turns is not in schema.sql");
  return current[0].replace(
    V27_CANONICAL_TURNS_CHECK,
    "    OR (outcome_kind = 'ABORTED'\n" +
      "        AND resolution_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE'))))",
  );
};

const TURN = {
  turn_request_id: "turn-1",
  target_actor_id: "actor:ceo",
  target_binding_id: "bind-1",
  target_attestation_id: "att-1",
  executor_session_id: "ses-1",
  executor_session_incarnation: "inc-1",
  binding_generation: 3,
  prompt_digest: "sha256:prompt",
  claimed_at: "2026-08-22T00:00:00.000Z",
  claim_audit_event_id: 7,
  lifecycle_state: "IN_DOUBT",
  observation_consistency: "CONSISTENT",
};

describe("a rebuild carries the rows it finds", () => {
  it("copies every column of an existing turn, including the four a hand-written list forgot", () => {
    const raw = new Database(join(tempDir("acp-rebuild-"), "state.sqlite"));
    try {
      // Foreign keys off, as the migration itself runs (`foreignKeysOffDuringApply`), so the turn
      // does not need its parents to exist for this to be about the copy.
      raw.pragma("foreign_keys = OFF");
      raw.exec(previousShape());
      const names = Object.keys(TURN);
      raw
        .prepare(
          `INSERT INTO canonical_turns (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        )
        .run(...Object.values(TURN));

      rebuildCanonicalTurnsIfStale(raw);

      const carried = raw.prepare(`SELECT * FROM canonical_turns`).all() as Array<Record<string, unknown>>;
      expect(carried).toHaveLength(1);
      // Field by field rather than a row count: a copy that dropped a column would still return
      // one row, and the four that were missing are exactly the ones a count cannot see.
      for (const [column, value] of Object.entries(TURN)) {
        expect(carried[0]?.[column], `column ${column}`).toBe(value);
      }

      // And the rebuilt table is the current one, which is the point of rebuilding it.
      const stored = (
        raw
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_turns'")
          .get() as { sql: string }
      ).sql;
      expect(stored).toContain("OPERATOR_AFTER_REVIEW");
    } finally {
      raw.close();
    }
  });

  it("does nothing when the stored definition is already current", () => {
    const raw = new Database(join(tempDir("acp-rebuild-current-"), "state.sqlite"));
    try {
      raw.pragma("foreign_keys = OFF");
      const current = /CREATE TABLE IF NOT EXISTS canonical_turns \([\s\S]*?\n\);/.exec(schemaDdl());
      raw.exec(current![0]);
      const before = (
        raw
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_turns'")
          .get() as { sql: string }
      ).sql;

      rebuildCanonicalTurnsIfStale(raw);

      // Not a no-op by accident: a rebuild that ran anyway would rewrite the DDL with the quoting
      // `ALTER TABLE … RENAME TO` produces, which is how the observations rebuild first reported a
      // table it had just rebuilt as still stale.
      expect(
        (
          raw
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_turns'")
            .get() as { sql: string }
        ).sql,
      ).toBe(before);
    } finally {
      raw.close();
    }
  });
});
