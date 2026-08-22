import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";

import {
  rebuildCanonicalTurnsIfStale,
  rebuildObservationsIfStale,
  schemaDdl,
  sharedColumns,
} from "../../src/db/migrations.ts";
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
  // Settled, with every settlement column populated. A review pointed out that an IN_DOUBT
  // fixture leaves `outcome_kind`, `settled_at`, `resolution_authority`, `reason_code` and
  // `evidence_digest` NULL, so a hand-written copy list omitting all five would still pass — the
  // fixture has to carry the columns the check is about.
  lifecycle_state: "SETTLED",
  outcome_kind: "ABORTED",
  settled_at: "2026-08-22T00:05:00.000Z",
  // An authority v27 already admitted: the row has to be one the *old* table would accept, since
  // it is a row that existed before the migration ran.
  resolution_authority: "OWNER_AFTER_TARGET_FENCE",
  reason_code: "OK",
  evidence_digest: "sha256:evidence",
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

  it("carries an observation too, which nothing was asking", () => {
    // The other rebuild, and the same question. A review pointed out that
    // `rebuildObservationsIfStale` was never exercised with a row either, so reverting *its* copy
    // to a hand-written list left every test passing.
    const raw = new Database(join(tempDir("acp-rebuild-obs-"), "state.sqlite"));
    try {
      raw.pragma("foreign_keys = OFF");
      const current = /CREATE TABLE IF NOT EXISTS canonical_turn_observations \([\s\S]*?\n\);/.exec(
        schemaDdl(),
      );
      if (current === null) throw new Error("canonical_turn_observations is not in schema.sql");
      // The v27 shape: the same table without the CHECK that admits the operator authority.
      raw.exec(
        current[0].replace(
          "        AND observing_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE',\n" +
            "                                    'OPERATOR_AFTER_REVIEW')))",
          "        AND observing_authority IN ('HERMES_TARGET', 'OWNER_AFTER_TARGET_FENCE')))",
        ),
      );
      const OBSERVATION = {
        observation_id: 1,
        turn_request_id: "turn-1",
        observed_outcome: "ABORTED",
        observing_authority: "OWNER_AFTER_TARGET_FENCE",
        receipt_id: "fence-1",
        evidence_digest: "sha256:fence",
        reason_code: "OK",
        observed_at: "2026-08-22T00:05:00.000Z",
        audit_event_id: 7,
        adjudicates_observation_id: null,
      };
      const names = Object.keys(OBSERVATION);
      raw
        .prepare(
          `INSERT INTO canonical_turn_observations (${names.join(", ")}) ` +
            `VALUES (${names.map(() => "?").join(", ")})`,
        )
        .run(...Object.values(OBSERVATION));

      rebuildObservationsIfStale(raw);

      const carried = raw.prepare(`SELECT * FROM canonical_turn_observations`).all() as Array<
        Record<string, unknown>
      >;
      expect(carried).toHaveLength(1);
      for (const [column, value] of Object.entries(OBSERVATION)) {
        expect(carried[0]?.[column], `column ${column}`).toBe(value);
      }
    } finally {
      raw.close();
    }
  });

  it("refuses to rebuild a table into one that would drop a column", () => {
    // The intersection is not, on its own, a lossless copy: a column the new table does not have
    // goes when the old table does, silently and permanently. Narrowing a table may be a
    // deliberate migration one day; it is never something a rebuild helper should do because
    // nobody listed the column.
    const raw = new Database(join(tempDir("acp-rebuild-narrow-"), "state.sqlite"));
    try {
      raw.pragma("foreign_keys = OFF");
      // Inserted among the column definitions, not after the CHECKs: SQLite wants every column
      // before the first table constraint, and appending one at the end is a syntax error rather
      // than the wider table this test needs.
      raw.exec(
        previousShape().replace(
          "  prompt_digest                 TEXT NOT NULL,",
          "  prompt_digest                 TEXT NOT NULL,\n  operator_note                 TEXT,",
        ),
      );
      raw
        .prepare(
          `INSERT INTO canonical_turns (turn_request_id, target_actor_id, target_binding_id,
             target_attestation_id, executor_session_id, executor_session_incarnation,
             binding_generation, prompt_digest, claimed_at, claim_audit_event_id, lifecycle_state,
             operator_note)
           VALUES ('turn-1', 'actor:ceo', 'bind-1', 'att-1', 'ses-1', 'inc-1', 3, 'sha256:p',
                   '2026-08-22T00:00:00.000Z', 7, 'IN_DOUBT', 'do not lose me')`,
        )
        .run();

      expect(() => rebuildCanonicalTurnsIfStale(raw)).toThrow(/drop column/);
      // And the row is still there, because the refusal happens before anything is dropped.
      expect(
        (raw.prepare(`SELECT operator_note FROM canonical_turns`).get() as { operator_note: string })
          .operator_note,
      ).toBe("do not lose me");
    } finally {
      raw.close();
    }
  });

  it("carries an ordinary column that the new table computes, without trying to write it", () => {
    // A review's counterexample against reading `hidden` from the source. An ordinary column that
    // becomes generated in the new table passes the missing-column check, reads `hidden = 0` on the
    // source, and lands in the INSERT — which SQLite refuses. The property is not "was this
    // computed before" but "can this be written now", and only the destination can answer it.
    //
    // It also pins `pragma_table_xinfo`: `table_info` omits generated columns entirely, so the
    // destination lookup would find nothing and the column would be copied anyway.
    const raw = new Database(join(tempDir("acp-rebuild-generated-"), "state.sqlite"));
    try {
      raw.pragma("foreign_keys = OFF");
      raw.exec(`CREATE TABLE t (a TEXT PRIMARY KEY, b TEXT)`);
      raw.prepare(`INSERT INTO t (a, b) VALUES ('one', 'ordinary')`).run();
      raw.exec(`CREATE TABLE t_rebuilt (a TEXT PRIMARY KEY, b TEXT GENERATED ALWAYS AS (a || '!') VIRTUAL)`);

      const columns = sharedColumns(raw, "t", "t_rebuilt");

      expect(columns).toEqual(["a"]);
      // And the copy it produces actually runs, which is the assertion the list alone does not make.
      raw.exec(`INSERT INTO t_rebuilt (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM t`);
      expect(raw.prepare(`SELECT b FROM t_rebuilt`).get()).toEqual({ b: "one!" });
    } finally {
      raw.close();
    }
  });

  it("refuses when the new table lacks a column, including one the old table computed", () => {
    // The missing-column check has to see generated and hidden source columns too, or a rebuild
    // drops one while reporting a lossless copy.
    const raw = new Database(join(tempDir("acp-rebuild-hidden-"), "state.sqlite"));
    try {
      raw.pragma("foreign_keys = OFF");
      raw.exec(`CREATE TABLE t (a TEXT PRIMARY KEY, b TEXT GENERATED ALWAYS AS (a || '!') VIRTUAL)`);
      raw.exec(`CREATE TABLE t_rebuilt (a TEXT PRIMARY KEY)`);

      expect(() => sharedColumns(raw, "t", "t_rebuilt")).toThrow(/drop column/);
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
