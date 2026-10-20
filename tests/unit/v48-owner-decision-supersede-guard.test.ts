import Database from "better-sqlite3";
import { existsSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { restoreDatabase } from "../../src/db/backup.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration, migrationApprovalPath } from "../../src/db/migration-approval.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { laterObjectsIn, releasedChainImage } from "../helpers/released-chain-image.ts";
import { digestOfSchemaRows, privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { V45_BASE_CHECKSUM, contentDigests } from "../helpers/released-v45-schema.ts";
import { V46_BASE_CHECKSUM } from "../helpers/released-v46-schema.ts";
import { V47_BASE_CHECKSUM, V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN } from "../helpers/released-v47-schema.ts";
import { OWNER_DECISION_SUPERSEDE_DENIED, V48_ADDED_TRIGGERS } from "../helpers/released-v48-schema.ts";


afterAll(cleanupTempDirs);

/**
 * SEC-OD1 (v48, CEO 072dbccb) — `run_artifacts_owner_decision_supersede_guard` and the three
 * `run_artifacts` rowid guards. An owner decision stops counting once its one-way superseded mark is set;
 * at v47 an ordinary write could set it on the owner's refusal, so the earlier approval decided again.
 *
 *   G1  On ACP's connection an ordinary `Db.run` cannot set the mark on any OWNER_DECISION APPROVAL shape
 *       (typed OWNER_AUTHORITY_NOT_DELEGABLE), in any UPDATE form; every other artifact's mark is as before.
 *   G2  Fail-closed: a connection whose marker function is missing, NULL, 0, 2, '1' or throws cannot set it.
 *       A connection that defines the marker to return 1 can: the stated Limit (CEO 52c3b1e6 (b)).
 *   R   The same removal through the hidden rowid, DELETE and REPLACE: on a connection with
 *       recursive_triggers off (SQLite's default) the rowid forms removed the decision at v47; now each
 *       form is refused and the decision stays.
 *   G3  Each predicate is load-bearing (mutation checks).
 *   S1  v47 → v48 on the released v47 image keeps every row and every receipt (v47's full checksum
 *       included) and adds only the four triggers and v48's receipt.
 *   S2  The step refuses any other object holding one of its names, or a non-positive rowid, restoring
 *       the image; it never drops or replaces. An exact pre-existing definition is accepted, and a repeated
 *       application changes nothing.
 *   S3  Rollback: a fault after v48 commits restores the v47 image, and the pre-migration backup restores
 *       through the operator restore drill.
 *
 * Pre-v48 and post-v48 are never mixed: what the released v47 image admits is measured on that image before
 * it is migrated, and every refusal on the image v48 produced.
 */

const NOW = "2026-10-18T00:00:00.000Z";
const RUN = "run_v48";
const CANDIDATE = `sha256:${"c".repeat(64)}`;
const LABEL = "production-gate:owner-decision";
const SENTINEL = OWNER_DECISION_SUPERSEDE_DENIED;
const NO_REPLACE = /RUN_ARTIFACT_NO_REPLACE/;
const [SUPERSEDE_GUARD, NO_ROWID_REPLACE, ROWID_IMMUTABLE, ROWID_POSITIVE] = V48_ADDED_TRIGGERS as [string, string, string, string];

/** An OWNER_DECISION record's content, as `recordOwnerDecision` writes it (receipt elided). */
const decision = (item: string, approved: boolean): Record<string, unknown> => ({
  kind: "OWNER_DECISION",
  item,
  approved,
  note: `${approved ? "approve" : "refuse"} ${item}`,
  at: NOW,
  humanGateDigest: "sha256:gate",
  candidateSnapshotDigest: CANDIDATE,
});

interface Row {
  id: string;
  kind: string;
  content: string;
  producedBy: string;
  candidate?: string | null;
}

let rowSeq = 0;
const row = (kind: string, content: unknown, producedBy: string, candidate: string | null = CANDIDATE): Row => ({
  id: `art_v48_${(rowSeq += 1)}`,
  kind,
  content: typeof content === "string" ? content : JSON.stringify(content),
  producedBy,
  candidate,
});

const INSERT = `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const params = (r: Row): unknown[] => [r.id, RUN, r.kind, `sha256:${r.id}`, r.candidate ?? null, r.content, r.producedBy, NOW];
const MARK = "UPDATE run_artifacts SET superseded = 1 WHERE artifact_id = ?";

/** A connection ACP did not open (recursive_triggers off), whose marker function is whatever `marker` says. */
const foreign = (path: string, marker?: () => unknown): Database.Database => {
  const raw = new Database(path);
  if (marker !== undefined) raw.function("acp_evidence_write_authorized", marker as () => number);
  return raw;
};

const tryRun = (raw: Database.Database, sql: string, args: unknown[]): string => {
  try {
    raw.prepare(sql).run(...args);
    return "ADMITTED";
  } catch (error) {
    return String((error as Error).message);
  }
};

/** Writes rows as ACP's capability writes do (marker 1); the run and its candidate snapshot first when asked. */
const seed = (path: string, rows: readonly Row[], withRun = false): void => {
  const capability = foreign(path, () => 1);
  try {
    if (withRun) {
      capability.prepare(
        `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
         VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED', 'v48 witness', 'sha256:contract', ?)`,
      ).run(RUN, NOW);
      capability.prepare(INSERT).run(...params(row("CANDIDATE_SNAPSHOT", { candidateSnapshotDigest: CANDIDATE }, "candidate-pipeline")));
    }
    for (const r of rows) capability.prepare(INSERT).run(...params(r));
  } finally {
    capability.close();
  }
};

/** A fresh database at the current version (v48), with a run and `rows`. */
const freshWith = (prefix: string, rows: readonly Row[]): string => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  seed(path, rows, true);
  return path;
};

/** Every column of an artifact, rowid included; undefined once it is gone. */
const stored = (path: string, id: string): unknown => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT rowid AS rid, * FROM run_artifacts WHERE artifact_id = ?").get(id);
  } finally {
    raw.close();
  }
};

const rowidOf = (path: string, id: string): number => (stored(path, id) as { rid: number }).rid;

/** The OWNER_DECISION APPROVAL shapes v47 recognises; the supersede guard reads the same predicate. */
const GUARDED: ReadonlyArray<{ name: string; row: () => Row }> = [
  { name: "the canonical label on an OWNER_DECISION refusal", row: () => row("APPROVAL", decision("item a", false), LABEL) },
  { name: "the canonical label on an OWNER_DECISION approval", row: () => row("APPROVAL", decision("item a", true), LABEL) },
  { name: "the canonical label on other content", row: () => row("APPROVAL", { kind: "NOT_A_DECISION" }, LABEL) },
  { name: "an OWNER_DECISION refusal labelled \"service\" (recorded before SEC-OD1)", row: () => row("APPROVAL", decision("item a", false), "service") },
  { name: "an OWNER_DECISION approval labelled \"service\"", row: () => row("APPROVAL", decision("item a", true), "service") },
  { name: "OWNER_DECISION content with no candidate", row: () => row("APPROVAL", decision("item a", false), "service", null) },
  {
    name: "a duplicate key that hides OWNER_DECISION from $.kind but not from JSON.parse",
    row: () => row("APPROVAL", `{"kind":"NOT_A_DECISION","kind":"OWNER_DECISION","item":"item a","approved":false}`, "service"),
  },
  { name: "an escaped key", row: () => row("APPROVAL", `{"k\\u0069nd":"OWNER_DECISION","item":"item a","approved":false}`, "service") },
];

const UNGUARDED: ReadonlyArray<{ name: string; row: () => Row }> = [
  { name: "a CTO approval", row: () => row("APPROVAL", { runId: RUN, resultSummary: "ok", recommendation: "merge" }, "service") },
  { name: "a repo-factory GitHub-write approval (bootstrap T3)", row: () => row("APPROVAL", { kind: "REPO_FACTORY_GITHUB_WRITE_APPROVAL", owner: "o" }, "service") },
  { name: "a CEO decision naming OWNER_DECISION_REQUIRED", row: () => row("APPROVAL", { kind: "CEO_DECISION", decision: "OWNER_DECISION_REQUIRED" }, "service") },
  { name: "OWNER_DECISION nested below the top level", row: () => row("APPROVAL", { kind: "CTO_APPROVAL", inner: { kind: "OWNER_DECISION" } }, "service") },
  { name: "an APPROVAL whose content is not JSON", row: () => row("APPROVAL", "not json", "service") },
  { name: "OWNER_DECISION content on a HANDOFF artifact", row: () => row("HANDOFF", decision("item a", false), "service") },
  { name: "a PLAN", row: () => row("PLAN", { tasks: [] }, "service") },
  { name: "VERIFICATION evidence", row: () => row("VERIFICATION", { candidateSnapshotDigest: CANDIDATE, passed: true }, "verification-engine") },
];

/** Every UPDATE form of the one-way mark. */
const MARK_FORMS: ReadonlyArray<{ name: string; sql: string; args: (id: string) => unknown[] }> = [
  { name: "UPDATE", sql: MARK, args: (id) => [id] },
  { name: "UPDATE OR IGNORE", sql: MARK.replace("UPDATE", "UPDATE OR IGNORE"), args: (id) => [id] },
  { name: "UPDATE OR REPLACE", sql: MARK.replace("UPDATE", "UPDATE OR REPLACE"), args: (id) => [id] },
  { name: "UPDATE OR FAIL", sql: MARK.replace("UPDATE", "UPDATE OR FAIL"), args: (id) => [id] },
  { name: "the text '1'", sql: "UPDATE run_artifacts SET superseded = '1' WHERE artifact_id = ?", args: (id) => [id] },
  { name: "a CTE", sql: "WITH target(id) AS (SELECT ?) UPDATE run_artifacts SET superseded = 1 WHERE artifact_id IN (SELECT id FROM target)", args: (id) => [id] },
  { name: "every APPROVAL of the run", sql: "UPDATE run_artifacts SET superseded = 1 WHERE run_id = ? AND kind = 'APPROVAL'", args: () => [RUN] },
];

describe("G1: on ACP's own connection, an ordinary Db.run cannot set an owner decision's superseded mark", () => {
  it.each(GUARDED)("refuses $name in every UPDATE form, typed OWNER_AUTHORITY_NOT_DELEGABLE; the flag stays 0", ({ row: make }) => {
    const r = make();
    const path = freshWith("acp-v48-g1-", [r]);
    const before = stored(path, r.id);
    const db = new Db(path);
    try {
      let refusal: unknown;
      try {
        db.run(MARK, [r.id]);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { sqlite: "OWNER_DECISION_SUPERSEDE_AUTHORITY_DENIED" },
      });
      for (const form of MARK_FORMS) expect(() => db.run(form.sql, form.args(r.id)), form.name).toThrowError(SENTINEL);
    } finally {
      db.close();
    }
    expect(stored(path, r.id)).toEqual(before);
  });

  it.each(UNGUARDED)("still marks $name superseded, as before v48", ({ row: make }) => {
    const r = make();
    const path = freshWith("acp-v48-g1-other-", [r]);
    const db = new Db(path);
    try {
      db.run(MARK, [r.id]);
      expect(db.get("SELECT superseded FROM run_artifacts WHERE artifact_id = ?", [r.id])).toEqual({ superseded: 1 });
      expect(() => db.run("UPDATE run_artifacts SET superseded = 0 WHERE artifact_id = ?", [r.id])).toThrowError(/ARTIFACT_IMMUTABLE/);
    } finally {
      db.close();
    }
  });
});

describe("G2: the supersede guard passes only when the marker is exactly 1", () => {
  const MARKERS: ReadonlyArray<{ name: string; marker?: () => unknown; refusal: RegExp }> = [
    { name: "missing", refusal: /no such function: acp_evidence_write_authorized/ },
    { name: "NULL", marker: () => null, refusal: SENTINEL },
    { name: "0", marker: () => 0, refusal: SENTINEL },
    { name: "2", marker: () => 2, refusal: SENTINEL },
    { name: "the text '1'", marker: () => "1", refusal: SENTINEL },
    { name: "an error", marker: () => { throw new Error("marker function failed"); }, refusal: /marker function failed/ },
  ];

  it.each(MARKERS)("a connection whose marker is $name cannot mark any guarded shape superseded", ({ marker, refusal }) => {
    const rows = GUARDED.map(({ row: make }) => make());
    const path = freshWith("acp-v48-g2-", rows);
    const raw = foreign(path, marker);
    try {
      for (const r of rows) expect(tryRun(raw, MARK, [r.id])).toMatch(refusal);
      expect(raw.prepare("SELECT COUNT(*) FROM run_artifacts WHERE superseded = 1").pluck().get()).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("LIMIT (CEO 52c3b1e6 (b)): a connection that defines the marker itself, to return 1, passes the supersede guard", () => {
    const rows = GUARDED.map(({ row: make }) => make());
    const path = freshWith("acp-v48-g2-limit-", rows);
    const raw = foreign(path, () => 1);
    try {
      for (const r of rows) expect(tryRun(raw, MARK, [r.id])).toBe("ADMITTED");
    } finally {
      raw.close();
    }
  });
});

/**
 * Each other write that would remove the decision's effect, against the guard that refuses it: on a
 * connection ACP did not open with its marker defined as 0 and recursive_triggers off, SQLite's default.
 */
const REMOVALS: ReadonlyArray<{ name: string; refusal: RegExp; run: (raw: Database.Database, path: string, target: Row, other: Row) => string }> = [
  {
    name: "an insert naming the decision's rowid (INSERT OR REPLACE)",
    refusal: NO_REPLACE,
    run: (raw, path, target) => tryRun(raw, `INSERT OR REPLACE INTO run_artifacts (rowid, artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
      VALUES (?, 'art_v48_by_rowid', ?, 'PLAN', 'sha256:by-rowid', NULL, '{}', 'service', ?)`, [rowidOf(path, target.id), RUN, NOW]),
  },
  {
    name: "REPLACE naming the decision's rowid",
    refusal: NO_REPLACE,
    run: (raw, path, target) => tryRun(raw, `REPLACE INTO run_artifacts (rowid, artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
      VALUES (?, 'art_v48_by_rowid_2', ?, 'PLAN', 'sha256:by-rowid-2', NULL, '{}', 'service', ?)`, [rowidOf(path, target.id), RUN, NOW]),
  },
  {
    name: "`UPDATE OR REPLACE … SET superseded = 1, rowid` onto the decision from another artifact",
    refusal: NO_REPLACE,
    run: (raw, path, target, other) => tryRun(raw, "UPDATE OR REPLACE run_artifacts SET superseded = 1, rowid = ? WHERE artifact_id = ?", [rowidOf(path, target.id), other.id]),
  },
  {
    name: "INSERT OR REPLACE on the decision's artifact id",
    refusal: NO_REPLACE,
    run: (raw, _path, target) => tryRun(raw, `INSERT OR REPLACE INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
      VALUES (?, ?, 'PLAN', 'sha256:by-id', NULL, '{}', 'service', ?)`, [target.id, RUN, NOW]),
  },
  { name: "DELETE", refusal: /ARTIFACT_IMMUTABLE/, run: (raw, _path, target) => tryRun(raw, "DELETE FROM run_artifacts WHERE artifact_id = ?", [target.id]) },
  {
    name: "delete, then reinsert as a PLAN, in one transaction",
    refusal: /ARTIFACT_IMMUTABLE/,
    run: (raw, _path, target) => {
      try {
        raw.transaction(() => {
          raw.prepare("DELETE FROM run_artifacts WHERE artifact_id = ?").run(target.id);
          raw.prepare(INSERT).run(target.id, RUN, "PLAN", "sha256:reinserted", null, "{}", "service", NOW);
        })();
        return "ADMITTED";
      } catch (error) {
        return String((error as Error).message);
      }
    },
  },
  {
    name: "UPDATE of its content (into an approval)",
    refusal: /ARTIFACT_IMMUTABLE/,
    run: (raw, _path, target) => tryRun(raw, "UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?", [JSON.stringify(decision("item a", true)), target.id]),
  },
  {
    name: "UPDATE of its candidate binding",
    refusal: /ARTIFACT_IMMUTABLE/,
    run: (raw, _path, target) => tryRun(raw, "UPDATE run_artifacts SET candidate_snapshot_digest = ? WHERE artifact_id = ?", [`sha256:${"e".repeat(64)}`, target.id]),
  },
];

describe("R: every other write that removes the decision is refused, and the decision stays", () => {
  it.each(REMOVALS)("$name", ({ refusal, run }) => {
    const target = row("APPROVAL", decision("item a", false), LABEL);
    const other = row("PLAN", { tasks: [] }, "service", null);
    const path = freshWith("acp-v48-r-", [target, other]);
    const before = { target: stored(path, target.id), other: stored(path, other.id) };
    const raw = foreign(path, () => 0);
    try {
      expect(raw.pragma("recursive_triggers", { simple: true })).toBe(0);
      expect(run(raw, path, target, other)).toMatch(refusal);
    } finally {
      raw.close();
    }
    expect({ target: stored(path, target.id), other: stored(path, other.id) }).toEqual(before);
  });

  it("on ACP's own connection each of them is refused as well", () => {
    for (const { name, refusal, run } of REMOVALS) {
      const target = row("APPROVAL", decision("item a", false), LABEL);
      const other = row("PLAN", { tasks: [] }, "service", null);
      const path = freshWith("acp-v48-r-acp-", [target, other]);
      const before = stored(path, target.id);
      const db = new Db(path);
      let outcome: string;
      try {
        // Db.run is the ordinary in-process path; the transaction form needs its own tx.
        const viaDb = {
          prepare: (sql: string) => ({ run: (...args: unknown[]) => db.run(sql, args) }),
          transaction: (body: () => void) => () => db.tx(body),
          pragma: () => 1,
        } as unknown as Database.Database;
        outcome = run(viaDb, path, target, other);
      } finally {
        db.close();
      }
      expect(outcome, name).toMatch(refusal.source === "RUN_ARTIFACT_NO_REPLACE" ? /RUN_ARTIFACT_NO_REPLACE|ARTIFACT_IMMUTABLE/ : refusal);
      expect(stored(path, target.id), name).toEqual(before);
    }
  });

  it("an explicit non-positive rowid is refused, so the insert guard cannot be turned against ordinary inserts", () => {
    const path = freshWith("acp-v48-r-positive-", []);
    const raw = foreign(path, () => 0);
    try {
      for (const rowid of [0, -1]) {
        expect(tryRun(raw, `INSERT INTO run_artifacts (rowid, artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
          VALUES (?, ?, ?, 'PLAN', ?, NULL, '{}', 'service', ?)`, [rowid, `art_v48_rowid_${rowid}`, RUN, `sha256:rowid-${rowid}`, NOW])).toMatch(NO_REPLACE);
      }
      expect(tryRun(raw, INSERT, params(row("PLAN", { tasks: [1] }, "service", null)))).toBe("ADMITTED");
    } finally {
      raw.close();
    }
  });
});

describe("G3 mutation checks: each predicate is load-bearing", () => {
  /** Replaces a stored trigger's text, as an older or weakened definition would read. */
  const mutate = (path: string, name: string, from: string | RegExp, to: string): void => {
    const raw = new Database(path);
    try {
      const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").pluck().get(name) as string;
      const mutated = sql.replace(from, to);
      expect(mutated).not.toBe(sql);
      raw.exec(`DROP TRIGGER ${name}`);
      raw.exec(mutated);
    } finally {
      raw.close();
    }
  };
  const drop = (path: string, name: string): void => {
    const raw = new Database(path);
    try {
      raw.exec(`DROP TRIGGER ${name}`);
    } finally {
      raw.close();
    }
  };
  const markOn = (path: string, marker: () => unknown, r: Row): string => {
    const raw = foreign(path, marker);
    try {
      return tryRun(raw, MARK, [r.id]);
    } finally {
      raw.close();
    }
  };

  it("without `IS NOT 1` (as `<> 1`, the evidence guard's form), a NULL marker withdraws a canonical refusal", () => {
    const r = row("APPROVAL", decision("item a", false), LABEL);
    const path = freshWith("acp-v48-mut-null-", [r]);
    expect(markOn(path, () => null, r)).toMatch(SENTINEL);
    mutate(path, SUPERSEDE_GUARD, "acp_evidence_write_authorized() IS NOT 1", "acp_evidence_write_authorized() <> 1");
    expect(markOn(path, () => null, r)).toBe("ADMITTED");
  });

  it("without the label clause, the canonical label on other content is withdrawn", () => {
    const r = row("APPROVAL", { kind: "NOT_A_DECISION" }, LABEL);
    const path = freshWith("acp-v48-mut-label-", [r]);
    expect(markOn(path, () => 0, r)).toMatch(SENTINEL);
    mutate(path, SUPERSEDE_GUARD, "OLD.produced_by = 'production-gate:owner-decision'", "0");
    expect(markOn(path, () => 0, r)).toBe("ADMITTED");
  });

  it("without the content clause, a refusal labelled \"service\" (recorded before SEC-OD1) is withdrawn", () => {
    const r = row("APPROVAL", decision("item a", false), "service");
    const path = freshWith("acp-v48-mut-content-", [r]);
    expect(markOn(path, () => 0, r)).toMatch(SENTINEL);
    mutate(path, SUPERSEDE_GUARD, "member.value = 'OWNER_DECISION'", "member.value = 'NEVER'");
    expect(markOn(path, () => 0, r)).toBe("ADMITTED");
  });

  it("reading only $.kind instead of every member, a duplicate-key refusal is withdrawn", () => {
    const r = row("APPROVAL", `{"kind":"NOT_A_DECISION","kind":"OWNER_DECISION","item":"item a","approved":false}`, "service");
    expect(JSON.parse(r.content).kind).toBe("OWNER_DECISION");
    const path = freshWith("acp-v48-mut-dup-", [r]);
    expect(markOn(path, () => 0, r)).toMatch(SENTINEL);
    mutate(path, SUPERSEDE_GUARD, /EXISTS \(\s*SELECT 1 FROM json_each\(OLD\.content_json\) member[\s\S]*?'OWNER_DECISION'\s*\)/, "json_extract(OLD.content_json, '$.kind') = 'OWNER_DECISION'");
    expect(markOn(path, () => 0, r)).toBe("ADMITTED");
  });

  it("without the APPROVAL clause reading `OLD.kind`, an owner refusal is withdrawn", () => {
    const r = row("APPROVAL", decision("item a", false), LABEL);
    const path = freshWith("acp-v48-mut-kind-", [r]);
    expect(markOn(path, () => 0, r)).toMatch(SENTINEL);
    mutate(path, SUPERSEDE_GUARD, "OLD.kind = 'APPROVAL'", "OLD.kind = 'NEVER'");
    expect(markOn(path, () => 0, r)).toBe("ADMITTED");
  });

  it("without the flag-change clause, an UPDATE of a decision's content reads as a supersede refusal, not ARTIFACT_IMMUTABLE (the clause leaves every other refusal where it was)", () => {
    const r = row("APPROVAL", decision("item a", false), LABEL);
    const path = freshWith("acp-v48-mut-flag-", [r]);
    const contentUpdate = (): unknown => {
      const db = new Db(path);
      try {
        db.run("UPDATE run_artifacts SET content_json = '{}' WHERE artifact_id = ?", [r.id]);
        return "ADMITTED";
      } catch (error) {
        return (error as { evidence?: unknown }).evidence;
      } finally {
        db.close();
      }
    };
    expect(markOn(path, () => 0, r)).toMatch(SENTINEL);
    expect(contentUpdate()).toEqual({ sqlite: "ARTIFACT_IMMUTABLE" });
    mutate(path, SUPERSEDE_GUARD, "NEW.superseded IS NOT OLD.superseded", "1");
    expect(contentUpdate()).toEqual({ sqlite: "OWNER_DECISION_SUPERSEDE_AUTHORITY_DENIED" });
  });

  it("without json_valid first, marking an ordinary APPROVAL whose content is not JSON is refused as malformed (a regression the clause prevents)", () => {
    const r = row("APPROVAL", "not json", "service");
    const path = freshWith("acp-v48-mut-valid-", [r]);
    const r2 = row("APPROVAL", "not json either", "service");
    seed(path, [r2]);
    expect(markOn(path, () => 0, r)).toBe("ADMITTED");
    mutate(path, SUPERSEDE_GUARD, "json_valid(OLD.content_json) = 1", "1");
    expect(markOn(path, () => 0, r2)).toMatch(/malformed JSON/);
  });

  it("without the insert-by-rowid guard, an INSERT OR REPLACE naming the decision's rowid deletes it", () => {
    const target = row("APPROVAL", decision("item a", false), LABEL);
    const path = freshWith("acp-v48-mut-rowid-insert-", [target]);
    drop(path, NO_ROWID_REPLACE);
    const raw = foreign(path, () => 0);
    try {
      expect(REMOVALS[0]!.run(raw, path, target, target)).toBe("ADMITTED");
    } finally {
      raw.close();
    }
    expect(stored(path, target.id)).toBeUndefined();
  });

  it("without the rowid-immutable guard, `UPDATE OR REPLACE … SET rowid` onto the decision deletes it", () => {
    const target = row("APPROVAL", decision("item a", false), LABEL);
    const other = row("PLAN", { tasks: [] }, "service", null);
    const path = freshWith("acp-v48-mut-rowid-update-", [target, other]);
    drop(path, ROWID_IMMUTABLE);
    const raw = foreign(path, () => 0);
    try {
      expect(REMOVALS[2]!.run(raw, path, target, other)).toBe("ADMITTED");
    } finally {
      raw.close();
    }
    expect(stored(path, target.id)).toBeUndefined();
  });

  it("without the positive-rowid guard, one artifact at rowid -1 makes the insert guard refuse every ordinary insert", () => {
    const path = freshWith("acp-v48-mut-rowid-positive-", []);
    drop(path, ROWID_POSITIVE);
    const raw = foreign(path, () => 0);
    try {
      expect(tryRun(raw, `INSERT INTO run_artifacts (rowid, artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
        VALUES (-1, 'art_v48_minus_one', ?, 'PLAN', 'sha256:minus-one', NULL, '{}', 'service', ?)`, [RUN, NOW])).toBe("ADMITTED");
      expect(tryRun(raw, INSERT, params(row("PLAN", { tasks: [2] }, "service", null)))).toMatch(NO_REPLACE);
    } finally {
      raw.close();
    }
  });
});

/** The released v47 image, built by running the released chain from the v11 fixture and stopping at v47. */
const releasedV47 = (prefix: string): string => {
  const path = releasedChainImage(privateStatePath(prefix), 47);
  expect(laterObjectsIn(path, 47)).toEqual([]);
  expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
  return path;
};

/** Receipts at or below v47, every column. */
const receiptsThrough47 = (path: string): unknown[] => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT * FROM schema_migrations WHERE version <= 47 ORDER BY version").all();
  } finally {
    raw.close();
  }
};

const triggersOf = (path: string): string[] => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").pluck().all() as string[];
  } finally {
    raw.close();
  }
};

/**
 * Rows as the v47 build left them: ACP's capability writes (marker 1), canonical and legacy "service"
 * OWNER_DECISION rows among them. On the released v47 image an ordinary connection (marker 0) withdraws
 * an owner refusal and deletes another through its rowid: the pre-v48 counterexample, measured on the v47
 * image before it is migrated.
 */
const seedAsV47 = (path: string): { kept: Row[]; withdrawnPreV48: Row; removedPreV48: Row } => {
  const kept = [
    row("APPROVAL", decision("item a", true), LABEL),
    row("APPROVAL", decision("item a", false), LABEL),
    row("APPROVAL", decision("item b", true), "service"),
    row("APPROVAL", decision("item b", false), "service"),
    row("APPROVAL", { runId: RUN, resultSummary: "ok", recommendation: "merge" }, "service"),
    row("VERIFICATION", { candidateSnapshotDigest: CANDIDATE, passed: true }, "verification-engine"),
    row("PLAN", { tasks: [] }, "service", null),
  ];
  const withdrawnPreV48 = row("APPROVAL", decision("item c", false), LABEL);
  const removedPreV48 = row("APPROVAL", decision("item d", false), "service");
  seed(path, [...kept, withdrawnPreV48, removedPreV48], true);
  const ordinary = foreign(path, () => 0);
  try {
    expect(tryRun(ordinary, MARK, [withdrawnPreV48.id])).toBe("ADMITTED");
    expect(tryRun(ordinary, "UPDATE OR REPLACE run_artifacts SET superseded = 1, rowid = ? WHERE artifact_id = ?", [rowidOf(path, removedPreV48.id), kept[6]!.id])).toBe("ADMITTED");
  } finally {
    ordinary.close();
  }
  expect(stored(path, removedPreV48.id)).toBeUndefined();
  return { kept, withdrawnPreV48, removedPreV48 };
};

describe("S1: the v47 → v48 step on the released v47 image", () => {
  it("is the step from 47, followed by v49 and v50, and v47 keeps the full checksum it shipped with", () => {
    expect(SCHEMA_VERSION).toBe(50);
    expect(MIGRATIONS.find((step) => step.fromVersion === 47)).toMatchObject({ id: "v48-owner-decision-supersede-guard", fromVersion: 47, toVersion: 48 });
    expect(MIGRATIONS.slice(-2)).toMatchObject([
      { id: "v49-branch-publish-receipts", fromVersion: 48, toVersion: 49 },
      { id: "v50-post-merge-verification-reentry", fromVersion: 49, toVersion: 50 },
    ]);
    expect(MIGRATIONS.find((step) => step.toVersion === 47)!.checksum()).toBe(V47_BASE_CHECKSUM);
  });

  it("keeps every row, legacy \"service\" OWNER_DECISION rows included, and every receipt through v47 byte for byte; adds only the four triggers and v48's receipt; then refuses the same withdrawal", () => {
    const path = releasedV47("acp-v48-s1-");
    const { kept, withdrawnPreV48 } = seedAsV47(path);
    const before = contentDigests(path);
    const receiptsBefore = receiptsThrough47(path);
    const triggersBefore = triggersOf(path);
    expect(before.userVersion).toBe(47);
    for (const name of V48_ADDED_TRIGGERS) expect(triggersBefore).not.toContain(name);
    expect(receiptsBefore.filter((r) => (r as { version: number }).version >= 45).map((r) => {
      const { version, migration_id, checksum } = r as { version: number; migration_id: string; checksum: string };
      return { version, migration_id, checksum };
    })).toEqual([
      { version: 45, migration_id: "v45-first-manifest-activation", checksum: V45_BASE_CHECKSUM },
      { version: 46, migration_id: "v46-rowid-no-replace", checksum: V46_BASE_CHECKSUM },
      { version: 47, migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM },
    ]);
    const rowsBefore = [...kept, withdrawnPreV48].map((r) => stored(path, r.id));

    approveMigration(path, "v48 S1 preservation witness");
    new Db(path).close();

    const after = contentDigests(path);
    // #512 S-PUSH: the approved chain runs on to v49, which rebuilds github_receipts with every row kept.
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    const { schema_migrations: receiptsDigestBefore, ...restBefore } = before.tables;
    const { schema_migrations: receiptsDigestAfter, ...restAfter } = after.tables;
    expect(restAfter).toEqual(restBefore);
    expect(receiptsDigestAfter).not.toBe(receiptsDigestBefore);
    expect(receiptsThrough47(path)).toEqual(receiptsBefore);
    expect(triggersOf(path)).toEqual([...triggersBefore, ...V48_ADDED_TRIGGERS].sort());
    expect([...kept, withdrawnPreV48].map((r) => stored(path, r.id))).toEqual(rowsBefore);
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT version, migration_id, checksum FROM schema_migrations WHERE version = 48").get()).toEqual({
        version: 48,
        migration_id: "v48-owner-decision-supersede-guard",
        checksum: MIGRATIONS.find((step) => step.toVersion === 48)!.checksum(),
      });
    } finally {
      raw.close();
    }

    // Post-v48, on the image v48 produced: the same withdrawals are refused.
    const db = new Db(path);
    try {
      for (const r of kept.slice(0, 4)) expect(() => db.run(MARK, [r.id])).toThrowError(SENTINEL);
    } finally {
      db.close();
    }
    const ordinary = foreign(path, () => 0);
    try {
      expect(tryRun(ordinary, MARK, [kept[3]!.id])).toMatch(SENTINEL);
      expect(tryRun(ordinary, "UPDATE OR REPLACE run_artifacts SET superseded = 1, rowid = ? WHERE artifact_id = ?", [rowidOf(path, kept[1]!.id), kept[4]!.id])).toMatch(NO_REPLACE);
    } finally {
      ordinary.close();
    }
    expect([...kept, withdrawnPreV48].map((r) => stored(path, r.id))).toEqual(rowsBefore);
  });

  it("the released v47 image migrated to v48 differs from it by exactly the four triggers, whose stored definitions are a fresh v48 install's", () => {
    const fresh = privateStatePath("acp-v48-fresh-");
    new Db(fresh).close();
    const freshGuards = schemaRowsOf(fresh).filter((r) => V48_ADDED_TRIGGERS.includes(r.name));
    expect(freshGuards).toHaveLength(4);
    const path = releasedV47("acp-v48-m3-");
    const before = schemaRowsOf(path);
    approveMigration(path, "v48 M3 witness");
    let after: ReturnType<typeof schemaRowsOf> = [];
    new Db(path, { afterMigration: (migration) => {
      if (migration.toVersion === 48) after = schemaRowsOf(path);
    } }).close();
    expect(after.filter((r) => !V48_ADDED_TRIGGERS.includes(r.name))).toEqual(before);
    expect(after.filter((r) => V48_ADDED_TRIGGERS.includes(r.name))).toEqual(freshGuards);
  });
});

describe("S2: whatever already holds a v48 name must be the trigger schema.sql defines", () => {
  const exactDefinitions = (): Map<string, string> => {
    const fresh = privateStatePath("acp-v48-exact-def-");
    new Db(fresh).close();
    return new Map(schemaRowsOf(fresh).filter((r) => V48_ADDED_TRIGGERS.includes(r.name)).map((r) => [r.name, r.sql!]));
  };

  it("an image that already holds the exact definitions is accepted, and a repeated application changes nothing", () => {
    const exact = exactDefinitions();
    const path = releasedV47("acp-v48-s2-exact-");
    const raw = new Database(path);
    try {
      for (const sql of exact.values()) raw.exec(sql);
    } finally {
      raw.close();
    }
    approveMigration(path, "v48 exact pre-existing definitions");
    new Db(path).close();
    const before = contentDigests(path);
    const repeat = new Database(path);
    try {
      MIGRATIONS.find((migration) => migration.toVersion === 48)!.apply(repeat);
    } finally {
      repeat.close();
    }
    expect(contentDigests(path)).toEqual(before);
  });

  const weakened = (as: string, timing: string, on: string): string =>
    `CREATE TRIGGER ${as} ${timing} ON ${on} WHEN 0 BEGIN SELECT RAISE(ABORT, 'RUN_ARTIFACT_NO_REPLACE'); END;`;
  const timingOf = (exact: string): string => /\n((?:BEFORE|AFTER) (?:INSERT|UPDATE)) ON run_artifacts\n/.exec(exact)![1]!;
  const VARIANTS: ReadonlyArray<{ variant: string; ddl: (name: string, exact: string) => string }> = [
    { variant: "a weakened body", ddl: (name, exact) => weakened(name, timingOf(exact), "run_artifacts") },
    {
      variant: "the exact body at the other timing (another trigger type)",
      ddl: (_name, exact) => exact.replace(`\n${timingOf(exact)} ON run_artifacts\n`, `\n${timingOf(exact).startsWith("BEFORE") ? timingOf(exact).replace("BEFORE", "AFTER") : timingOf(exact).replace("AFTER", "BEFORE")} ON run_artifacts\n`),
    },
    { variant: "a trigger on another table", ddl: (name, exact) => weakened(name, timingOf(exact), "projects") },
    { variant: "an index", ddl: (name) => `CREATE INDEX ${name} ON run_artifacts(artifact_id)` },
    { variant: "an upper-case name with the exact body", ddl: (name, exact) => exact.replace(name, name.toUpperCase()) },
  ];
  const CASES = V48_ADDED_TRIGGERS.flatMap((name) => VARIANTS.map(({ variant, ddl }) => ({ name, variant, ddl })));

  it.each(CASES)("$name held by $variant refuses the step and restores the v47 image, with no v48 receipt", ({ name, ddl }) => {
    const exact = exactDefinitions().get(name)!;
    const path = releasedV47("acp-v48-s2-contaminated-");
    const raw = new Database(path);
    try {
      raw.exec(ddl(name, exact));
    } finally {
      raw.close();
    }
    const contaminated = contentDigests(path);
    approveMigration(path, "v48 contamination witness");
    let refusal: unknown;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/original database was restored/);
    expect(String((refusal as { evidence?: { migrationError?: unknown } } | undefined)?.evidence?.migrationError))
      .toMatch(new RegExp(`^v48 refuses: ${name} is held by the`));
    expect(contentDigests(path)).toEqual(contaminated);
    const probe = new Database(path, { readonly: true });
    try {
      expect(probe.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 48").pluck().get()).toBe(0);
    } finally {
      probe.close();
    }
  });

  it("a run_artifacts row at a non-positive rowid refuses the step, naming its count; no row is deleted or renumbered", () => {
    const path = releasedV47("acp-v48-s2-nonpositive-");
    seed(path, [], true);
    const raw = foreign(path, () => 1);
    try {
      raw.prepare(`INSERT INTO run_artifacts (rowid, artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
        VALUES (0, 'art_v48_rowid_zero', ?, 'PLAN', 'sha256:rowid-zero', NULL, '{}', 'service', ?)`).run(RUN, NOW);
    } finally {
      raw.close();
    }
    const before = contentDigests(path);
    approveMigration(path, "v48 non-positive rowid witness");
    let refusal: unknown;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/original database was restored/);
    expect(String((refusal as { evidence?: { migrationError?: unknown } } | undefined)?.evidence?.migrationError))
      .toBe("v48 refuses to guard rowids: run_artifacts holds 1 row(s) with rowid <= 0; no row was deleted or renumbered");
    expect(contentDigests(path)).toEqual(before);
    expect(stored(path, "art_v48_rowid_zero")).toMatchObject({ rid: 0 });
  });
});

describe("S3: rollback through the restore drill", () => {
  it("a fault injected after v48 commits restores the v47 image, and a fresh approval then migrates it", () => {
    const path = releasedV47("acp-v48-s3-fault-");
    seedAsV47(path);
    const before = contentDigests(path);
    approveMigration(path, "v48 fault witness");
    expect(() => new Db(path, {
      afterMigration: (migration) => {
        if (migration.toVersion === 48) throw new Error("injected after v48 commits");
      },
    })).toThrowError(/original database was restored/);
    expect(contentDigests(path)).toEqual(before);
    for (const name of V48_ADDED_TRIGGERS) expect(triggersOf(path)).not.toContain(name);
    approveMigration(path, "v48 fault witness, again");
    new Db(path).close();
    expect(contentDigests(path).userVersion).toBe(SCHEMA_VERSION);
    expect(existsSync(migrationApprovalPath(path))).toBe(false);
  });

  it("the pre-migration backup v48 recorded restores the v47 image through the operator restore", () => {
    const path = releasedV47("acp-v48-s3-restore-");
    seedAsV47(path);
    const before = contentDigests(path);
    approveMigration(path, "v48 restore witness");
    new Db(path).close();
    const raw = new Database(path, { readonly: true });
    let backupFile: string;
    try {
      backupFile = raw.prepare("SELECT backup_file FROM schema_migrations WHERE version = 48").pluck().get() as string;
    } finally {
      raw.close();
    }
    expect(backupFile).toBeTruthy();
    restoreDatabase(path, backupFile);
    expect(contentDigests(path)).toEqual(before);
    for (const name of V48_ADDED_TRIGGERS) expect(triggersOf(path)).not.toContain(name);
  });
});
