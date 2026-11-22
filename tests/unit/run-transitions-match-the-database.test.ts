import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { legalTargets } from "../../src/domain/run-state.ts";
import { RunKind, RunState } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { privateStatePath } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);

/**
 * CP-HI-02 — the database's run edges are the TS table's. The two state guards list every edge some kind may take,
 * and the kind triggers narrow them; this test holds both against `legalTargets` for every kind × from × to.
 */
const KINDS = Object.values(RunKind);
const STATES = Object.values(RunState);

/** A private raw copy of a fresh database at SCHEMA_VERSION, keeping only the `runs` triggers `keep` admits. */
const rawCopy = (prefix: string, keep: (trigger: { name: string; sql: string }) => boolean): Database.Database => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  const raw = new Database(path);
  const triggers = raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'runs'")
    .all() as Array<{ name: string; sql: string }>;
  for (const trigger of triggers) if (!keep(trigger)) raw.exec(`DROP TRIGGER "${trigger.name}"`);
  return raw;
};

/** Each edge from a fresh row of `kind` in `from`, rolled back; returns the refusal message, or null. */
const attempt = (raw: Database.Database, kind: string, from: string, to: string): string | null => {
  raw.exec("BEGIN");
  try {
    raw.prepare(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
      VALUES ('run_edge', ?, 'STANDARD', 'NORMAL', ?, 'edge', 'sha256:c', '2026-11-20')`).run(kind, from);
    raw.prepare("UPDATE runs SET state = ? WHERE run_id = 'run_edge'").run(to);
    return null;
  } catch (error) {
    return (error as Error).message;
  } finally {
    raw.exec("ROLLBACK");
  }
};

describe("run transitions match the database (CP-HI-02)", () => {
  it("refuses an edge for a kind exactly when legalTargets omits it", () => {
    const raw = rawCopy("acp-run-edges-topology-", (trigger) => trigger.sql.includes("RUN_STATE_TRANSITION_ILLEGAL"));
    raw.function("acp_run_state_transition_authorized", { varargs: true }, () => 1);
    try {
      const mismatches: string[] = [];
      for (const kind of KINDS) for (const from of STATES) {
        const legal = legalTargets(from, kind);
        for (const to of STATES) {
          if (from === to) continue;
          const refusal = attempt(raw, kind, from, to);
          const refused = refusal !== null && /RUN_STATE_TRANSITION_ILLEGAL/.test(refusal);
          if (refusal !== null && !refused) mismatches.push(`${kind} ${from} → ${to}: ${refusal}`);
          else if (refused === legal.includes(to)) mismatches.push(`${kind} ${from} → ${to}: database ${refused ? "refuses" : "allows"}`);
        }
      }
      expect(mismatches).toEqual([]);
    } finally { raw.close(); }
  });

  it("asks the authority marker for exactly the edges some kind may take", () => {
    const raw = rawCopy("acp-run-edges-authority-", (trigger) => trigger.name === "runs_state_transition_authority_guard");
    raw.function("acp_run_state_transition_authorized", { varargs: true }, () => 0);
    try {
      const mismatches: string[] = [];
      for (const from of STATES) {
        const someKind = new Set(KINDS.flatMap((kind) => legalTargets(from, kind)));
        for (const to of STATES) {
          if (from === to) continue;
          const refusal = attempt(raw, RunKind.STANDARD_WORK, from, to);
          const denied = refusal !== null && /RUN_STATE_TRANSITION_AUTHORITY_DENIED/.test(refusal);
          if (refusal !== null && !denied) mismatches.push(`${from} → ${to}: ${refusal}`);
          else if (denied !== someKind.has(to)) mismatches.push(`${from} → ${to}: marker ${denied ? "asked" : "not asked"}`);
        }
      }
      expect(mismatches).toEqual([]);
    } finally { raw.close(); }
  });
});
