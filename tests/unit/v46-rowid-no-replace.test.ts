import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration, migrationApprovalPath } from "../../src/db/migration-approval.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { V44_SCHEMA_DIGEST_FROM_V43, digestOfSchemaRows, privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { contentDigests, toV44Image } from "../helpers/released-v45-schema.ts";
import { V45_SCHEMA_DIGEST, V46_ADDED_TRIGGERS, toV45Image } from "../helpers/released-v46-schema.ts";

afterAll(cleanupTempDirs);

/**
 * #1094 (v46) — `outbox`, `inbound_messages` and `canonical_turns` are rowid tables whose `_no_replace`
 * triggers compare declared keys only, so a write that names an existing rowid replaced or deleted a row
 * without colliding on any key.
 *
 *   B1  INSERT OR REPLACE naming an existing rowid with a new key is refused with the table's sentinel,
 *       on ACP's connection and on a second default connection.
 *   B2  UPDATE OR REPLACE moving a row onto another row's rowid is refused; a row's rowid never moves.
 *   B3  An explicit rowid <= 0 is refused. Ordinary inserts, INSERT OR IGNORE and ordinary updates are
 *       admitted, and a declared-key collision is refused as before (the declared-key tests are unedited).
 *   B4  A v45 image holding a row whose rowid <= 0 blocks the step, which names the table and the count
 *       and deletes nothing; otherwise every table is preserved, hidden rowid and arrival order included.
 *   D5-b A process killed between v45 and v46 leaves v45, and only a re-approval naming [v46] continues.
 *
 * Raw SQL here is the write under test, never a precondition that skips a guard. These guards are not a
 * boundary against a raw writer, which can drop a trigger; they close REPLACE through the hidden rowid.
 *
 * RED at 04a97e36 (main, the v45 build): there is no v46, so every replacement, deletion and non-positive
 * insert below is admitted, or refused only by an unrelated delete guard under another sentinel.
 */

const NOW = "2026-10-18T00:00:00.000Z";
const ROWS = 12;

type Row = Record<string, string | number | null>;

interface Spec {
  table: "outbox" | "inbound_messages" | "canonical_turns";
  key: string;
  sentinel: RegExp;
  /** Rows of other tables that `row(n)` names, for n in 1..ROWS. */
  prerequisites(db: Db): void;
  /** A complete row whose declared keys collide with no other `row(m)`. */
  row(n: number): Row;
}

/** A canonical turn names a session, an actor, its binding, an assignment and an attestation. */
const turnTargets = (db: Db): void => {
  db.run(`INSERT INTO audit_events (event_id, at, kind, evidence_json) VALUES (9001, ?, 'V46_FIXTURE', '{}')`, [NOW]);
  for (let n = 1; n <= ROWS; n += 1) {
    db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, ?, 'claude', 'opus', 'READY', ?, ?)`,
      [`ses_${n}`, `inc_${n}`, NOW, NOW],
    );
    db.run(
      `INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
       VALUES (?, 'CEO', ?, ?, ?)`,
      [`actor_${n}`, `ses_${n}`, `inc_${n}`, NOW],
    );
    db.run(
      `INSERT INTO actor_target_bindings
         (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
       VALUES (?, ?, 'hermes', ?, ?, ?)`,
      [`bind_${n}`, `actor_${n}`, `locator_${n}`, `digest_${n}`, NOW],
    );
    db.run(
      `INSERT INTO assignments
         (assignment_id, role_key, role, actor_id, session_id, session_incarnation, binding_generation, mode, status, created_at)
       VALUES (?, ?, 'CEO', ?, ?, ?, 1, 'PREFERRED', 'ACTIVE', ?)`,
      [`asg_${n}`, `CEO:actor_${n}`, `actor_${n}`, `ses_${n}`, `inc_${n}`, NOW],
    );
    db.run(
      `INSERT INTO actor_target_attestations
         (target_attestation_id, target_binding_id, protocol_version, attestation_digest, executor_session_id,
          executor_session_incarnation, binding_generation, assignment_id, attested_at)
       VALUES (?, ?, 'v1', ?, ?, ?, 1, ?, ?)`,
      [`att_${n}`, `bind_${n}`, `att_digest_${n}`, `ses_${n}`, `inc_${n}`, `asg_${n}`, NOW],
    );
  }
};

const SPECS: Spec[] = [
  {
    table: "outbox",
    key: "message_id",
    sentinel: /OUTBOX_NO_REPLACE/,
    prerequisites: () => {},
    row: (n) => ({
      message_id: `msg_${n}`, idempotency_key: `idem_${n}`, role_key: "PRIMARY_CTO:p", binding_generation: 1,
      target_session_id: "sess_cto", kind: "RUN_DISPATCH", payload_json: "{}", payload_digest: "sha256:x",
      request_fingerprint: `fp_${n}`, expires_at: "2099-01-01T00:00:00.000Z", created_at: NOW, status: "PENDING",
    }),
  },
  {
    table: "inbound_messages",
    key: "nonce",
    sentinel: /INBOUND_MESSAGE_NO_REPLACE/,
    prerequisites: () => {},
    row: (n) => ({
      channel: "telegram", nonce: `update:${n}`, actor: "owner", received_at: NOW,
      payload_json: JSON.stringify({ text: `message ${n}` }),
    }),
  },
  {
    table: "canonical_turns",
    key: "turn_request_id",
    sentinel: /CANONICAL_TURN_NO_REPLACE/,
    prerequisites: turnTargets,
    // One actor per turn: an actor holds one unresolved turn at a time.
    row: (n) => ({
      turn_request_id: `turn_${n}`, target_actor_id: `actor_${n}`, target_binding_id: `bind_${n}`,
      target_attestation_id: `att_${n}`, executor_session_id: `ses_${n}`, executor_session_incarnation: `inc_${n}`,
      binding_generation: 1, prompt_digest: "sha256:prompt", claimed_at: NOW, claim_audit_event_id: 9001,
      lifecycle_state: "IN_DOUBT",
    }),
  },
];

interface Conn {
  run(sql: string, values?: unknown[]): void;
  close(): void;
}

/** ACP's own connection: its markers registered, recursive triggers and foreign keys on. */
const acpConnection = (path: string): Conn => {
  const db = new Db(path);
  return { run: (sql, values = []) => void db.run(sql, values), close: () => db.close() };
};

/**
 * A second, default connection: recursive triggers off (asserted), foreign keys at the driver's default.
 * The connection-local markers ACP's triggers call do not exist on it, so it registers the two these
 * writes compile against, refusing: without them SQLite cannot prepare a canonical-turn or inbound write
 * at all ("no such function"), which is a refusal, but not the one under test.
 */
const foreignConnection = (path: string): Conn => {
  const raw = new Database(path);
  expect(raw.pragma("recursive_triggers", { simple: true })).toBe(0);
  for (const marker of ["acp_turn_materialization_authorized", "acp_ingress_claim_authorized"]) {
    raw.function(marker, { varargs: true }, () => 0);
  }
  return { run: (sql, values = []) => void raw.prepare(sql).run(...(values as never[])), close: () => raw.close() };
};

const CONNECTIONS: Array<[string, (path: string) => Conn]> = [
  ["ACP's connection", acpConnection],
  ["a second default connection", foreignConnection],
];

const insert = (conn: Conn, verb: string, spec: Spec, row: Row, rowid?: number): void => {
  const columns = [...(rowid === undefined ? [] : ["rowid"]), ...Object.keys(row)];
  const values = [...(rowid === undefined ? [] : [rowid]), ...Object.values(row)];
  conn.run(`${verb} INTO ${spec.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, values);
};

/** Every row of the table as (rowid, declared key, whole row), in rowid order. */
const snapshot = (path: string, spec: Spec): Array<{ r: number; k: string; row: string }> => {
  const raw = new Database(path, { readonly: true });
  try {
    return (raw.prepare(`SELECT rowid AS r, ${spec.key} AS k, * FROM ${spec.table} ORDER BY rowid`).all() as Array<Record<string, unknown>>)
      .map(({ r, k, ...row }) => ({ r: r as number, k: k as string, row: JSON.stringify(row) }));
  } finally {
    raw.close();
  }
};

/** A fresh database at this build's version holding `row(1)` and `row(2)`, inserted the ordinary way. */
const seeded = (spec: Spec, prefix: string): string => {
  const path = privateStatePath(`acp-v46-${prefix}-`);
  const db = new Db(path);
  try {
    spec.prerequisites(db);
    for (const n of [1, 2]) insert({ run: (sql, values = []) => void db.run(sql, values), close: () => {} }, "INSERT", spec, spec.row(n));
  } finally {
    db.close();
  }
  return path;
};

describe.each(SPECS)("#1094 on $table", (spec) => {
  it.each(CONNECTIONS)("B1 on %s: INSERT OR REPLACE or REPLACE naming an existing rowid with a new key is refused; the row stays", (_, open) => {
    const path = seeded(spec, `b1-${spec.table}`);
    const before = snapshot(path, spec);
    expect(before.map((row) => row.r)).toEqual([1, 2]);
    const conn = open(path);
    try {
      expect(() => insert(conn, "INSERT OR REPLACE", spec, spec.row(3), before[0]!.r)).toThrow(spec.sentinel);
      expect(() => insert(conn, "REPLACE", spec, spec.row(4), before[1]!.r)).toThrow(spec.sentinel);
    } finally {
      conn.close();
    }
    expect(snapshot(path, spec)).toEqual(before);
  });

  it.each(CONNECTIONS)("B2 on %s: UPDATE OR REPLACE onto another row's rowid is refused, as is any rowid move; both rows stay", (_, open) => {
    const path = seeded(spec, `b2-${spec.table}`);
    const before = snapshot(path, spec);
    const conn = open(path);
    try {
      expect(() =>
        conn.run(`UPDATE OR REPLACE ${spec.table} SET rowid = ? WHERE ${spec.key} = ?`, [before[1]!.r, before[0]!.k]),
      ).toThrow(spec.sentinel);
      expect(() => conn.run(`UPDATE ${spec.table} SET rowid = 9999 WHERE ${spec.key} = ?`, [before[0]!.k])).toThrow(spec.sentinel);
    } finally {
      conn.close();
    }
    expect(snapshot(path, spec)).toEqual(before);
  });

  it.each(CONNECTIONS)("B3 on %s: an explicit rowid of 0 or -1 is refused; ordinary inserts, INSERT OR IGNORE and updates are admitted; a declared-key collision is refused as before", (_, open) => {
    const path = seeded(spec, `b3-${spec.table}`);
    const before = snapshot(path, spec);
    const conn = open(path);
    try {
      expect(() => insert(conn, "INSERT", spec, spec.row(3), 0)).toThrow(spec.sentinel);
      expect(() => insert(conn, "INSERT", spec, spec.row(4), -1)).toThrow(spec.sentinel);
      expect(snapshot(path, spec)).toEqual(before);

      insert(conn, "INSERT", spec, spec.row(5));
      insert(conn, "INSERT OR IGNORE", spec, spec.row(6));
      // An update that keeps the rowid is not a rowid move.
      conn.run(`UPDATE ${spec.table} SET ${spec.key} = ${spec.key} WHERE ${spec.key} = ?`, [before[0]!.k]);
      // The existing declared-key class, rowid not named: refused by `<table>_no_replace`, unchanged.
      expect(() => insert(conn, "INSERT OR REPLACE", spec, spec.row(1))).toThrow(spec.sentinel);
    } finally {
      conn.close();
    }
    const after = snapshot(path, spec);
    // Arrival order: the new rows take the next positive rowids, after the ones already there.
    expect(after.map(({ r, k }) => ({ r, k }))).toEqual([
      ...before.map(({ r, k }) => ({ r, k })),
      { r: 3, k: String(spec.row(5)[spec.key]) },
      { r: 4, k: String(spec.row(6)[spec.key]) },
    ]);
    expect(after.slice(0, 2)).toEqual(before);
  });

  it("B4: a v45 image holding a row whose rowid <= 0 blocks the step, which names the table and count; the image is unchanged", () => {
    const path = privateStatePath(`acp-v46-b4-${spec.table}-`);
    const db = new Db(path);
    try {
      spec.prerequisites(db);
      insert({ run: (sql, values = []) => void db.run(sql, values), close: () => {} }, "INSERT", spec, spec.row(1));
    } finally {
      db.close();
    }
    toV45Image(path);
    const legacy = foreignConnection(path);
    try {
      insert(legacy, "INSERT", spec, spec.row(2), -1);
      insert(legacy, "INSERT", spec, spec.row(3), 0);
    } finally {
      legacy.close();
    }
    const before = contentDigests(path);
    expect(before.userVersion).toBe(45);
    approveMigration(path, "V46 B4 witness");
    let refusal: unknown;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    expect((refusal as Error | undefined)?.message).toMatch(/original database was restored/);
    const reported = String((refusal as { evidence?: { migrationError?: unknown } }).evidence?.migrationError);
    expect(reported).toContain(`${spec.table} holds 2 row(s) with rowid <= 0`);
    expect(reported).toContain("no row was deleted or renumbered");
    for (const other of SPECS.filter((s) => s !== spec)) expect(reported).not.toContain(`${other.table} holds`);
    // Nothing deleted, nothing renumbered: the restored image is the one approved, byte for byte.
    expect(contentDigests(path)).toEqual(before);
    expect(snapshot(path, spec).map(({ r, k }) => ({ r, k }))).toEqual([
      { r: -1, k: String(spec.row(2)[spec.key]) },
      { r: 0, k: String(spec.row(3)[spec.key]) },
      { r: 1, k: String(spec.row(1)[spec.key]) },
    ]);
  });
});

describe("mutation checks: each v46 guard is load-bearing", () => {
  /** Recreates `trigger` with `from` replaced by `to` on a raw connection, asserting the body changed. */
  const mutate = (path: string, trigger: string, from: string, to: string): void => {
    const raw = new Database(path);
    try {
      const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger) as { sql: string }).sql;
      const mutated = sql.replace(from, to);
      expect(mutated, `${trigger}: mutation applied`).not.toBe(sql);
      raw.exec(`DROP TRIGGER ${trigger}`);
      raw.exec(mutated);
    } finally {
      raw.close();
    }
  };

  it.each(SPECS)("$table: without the rowid comparison a REPLACE by rowid replaces the row", (spec) => {
    const path = seeded(spec, `mut-insert-${spec.table}`);
    const before = snapshot(path, spec);
    mutate(path, `${spec.table}_no_rowid_replace`, "rowid = NEW.rowid", "rowid = NEW.rowid AND 0");
    const conn = foreignConnection(path);
    try {
      insert(conn, "INSERT OR REPLACE", spec, spec.row(3), before[0]!.r);
    } finally {
      conn.close();
    }
    expect(snapshot(path, spec).map(({ r, k }) => ({ r, k }))).toEqual([
      { r: 1, k: String(spec.row(3)[spec.key]) },
      { r: 2, k: before[1]!.k },
    ]);
  });

  it.each(SPECS)("$table: without the rowid-move check an UPDATE OR REPLACE deletes the other row", (spec) => {
    const path = seeded(spec, `mut-update-${spec.table}`);
    const before = snapshot(path, spec);
    mutate(path, `${spec.table}_rowid_immutable`, "NEW.rowid IS NOT OLD.rowid", "0");
    const conn = foreignConnection(path);
    try {
      conn.run(`UPDATE OR REPLACE ${spec.table} SET rowid = ? WHERE ${spec.key} = ?`, [before[1]!.r, before[0]!.k]);
    } finally {
      conn.close();
    }
    expect(snapshot(path, spec).map(({ r, k }) => ({ r, k }))).toEqual([{ r: 2, k: before[0]!.k }]);
  });

  it.each(SPECS)("$table: without the positive check a rowid -1 is admitted, and then every ordinary insert is refused", (spec) => {
    const path = seeded(spec, `mut-positive-${spec.table}`);
    mutate(path, `${spec.table}_rowid_positive`, "NEW.rowid <= 0", "NEW.rowid <= 0 AND 0");
    const conn = foreignConnection(path);
    try {
      insert(conn, "INSERT", spec, spec.row(3), -1);
      // `NEW.rowid` is -1 in a BEFORE INSERT trigger when no rowid is named, so the insert guard now
      // matches the planted row for every ordinary insert. This is the hazard the positive guard and
      // the v46 pre-check exist to prevent.
      expect(() => insert(conn, "INSERT", spec, spec.row(4))).toThrow(spec.sentinel);
    } finally {
      conn.close();
    }
    expect(snapshot(path, spec).map(({ r }) => r)).toEqual([-1, 1, 2]);
  });

  it("the pre-check is load-bearing: v46's triggers installed over a v45 image holding rowid -1 refuse every ordinary insert", () => {
    const spec = SPECS[0]!;
    const path = seeded(spec, "mut-precheck");
    toV45Image(path);
    const raw = new Database(path);
    try {
      raw.prepare(`INSERT INTO outbox (rowid, ${Object.keys(spec.row(3)).join(", ")}) VALUES (-1, ${Object.keys(spec.row(3)).map(() => "?").join(", ")})`)
        .run(...(Object.values(spec.row(3)) as never[]));
      // What the step would install without its count, read from a database this build wrote.
      const reference = privateStatePath("acp-v46-mut-precheck-ref-");
      new Db(reference).close();
      const definitions = new Database(reference, { readonly: true });
      try {
        for (const name of V46_ADDED_TRIGGERS) {
          raw.exec((definitions.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string }).sql);
        }
      } finally {
        definitions.close();
      }
      const ordinary = spec.row(4);
      expect(() =>
        raw.prepare(`INSERT INTO outbox (${Object.keys(ordinary).join(", ")}) VALUES (${Object.keys(ordinary).map(() => "?").join(", ")})`)
          .run(...(Object.values(ordinary) as never[])),
      ).toThrow(/OUTBOX_NO_REPLACE/);
    } finally {
      raw.close();
    }
  });
});

describe("the v45 → v46 step", () => {
  it("is the step from 45 to 46; the chain runs on past it when the current version is later (v47, SEC-OD1)", () => {
    expect(MIGRATIONS.find((step) => step.id === "v46-rowid-no-replace")).toMatchObject({ fromVersion: 45, toVersion: 46 });
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(46);
  });

  it("M3: the v45 image is the v45 build's, and a fresh v46 install equals it migrated to v46, apart from receipts", () => {
    const fresh = privateStatePath("acp-v46-fresh-");
    new Db(fresh).close();
    const path = privateStatePath("acp-v46-m3-");
    new Db(path).close();
    toV45Image(path);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V45_SCHEMA_DIGEST);
    approveMigration(path, "V46 M3 witness");
    new Db(path).close();
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(digestOfSchemaRows(schemaRowsOf(fresh)));
    const raw = new Database(path, { readonly: true });
    try {
      const triggers = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").pluck().all() as string[];
      for (const name of V46_ADDED_TRIGGERS) expect(triggers).toContain(name);
    } finally {
      raw.close();
    }
  });

  it("B4: v45 → v46 preserves every pre-existing table byte for byte, hidden rowid and arrival order included; only schema_migrations gains its row", () => {
    const path = privateStatePath("acp-v46-b4-preserve-");
    const db = new Db(path);
    const conn: Conn = { run: (sql, values = []) => void db.run(sql, values), close: () => {} };
    try {
      for (const spec of SPECS) spec.prerequisites(db);
      for (const n of [1, 2, 3, 4]) for (const spec of SPECS) insert(conn, "INSERT", spec, spec.row(n));
    } finally {
      db.close();
    }
    toV45Image(path);
    const orderBefore = SPECS.map((spec) => snapshot(path, spec));
    const before = contentDigests(path);
    expect(before.userVersion).toBe(45);
    approveMigration(path, "V46 B4 preservation witness");
    new Db(path).close();
    const after = contentDigests(path, before.userVersion);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    const { schema_migrations: receiptsBefore, ...restBefore } = before.tables;
    const { schema_migrations: receiptsAfter, ...restAfter } = after.tables;
    expect(restAfter).toEqual(restBefore);
    expect(receiptsAfter).not.toBe(receiptsBefore);
    expect(SPECS.map((spec) => snapshot(path, spec))).toEqual(orderBefore);
    const raw = new Database(path, { readonly: true });
    try {
      const receipts = raw.prepare("SELECT version, migration_id FROM schema_migrations ORDER BY version").all();
      // v47 and v48 (SEC-OD1) follow on the same approved chain and add triggers, no row; v49 (#512 S-PUSH)
      // rebuilds github_receipts with every row and rowid kept, which the table digests above compare.
      expect(receipts).toEqual([
        { version: 45, migration_id: "bootstrap-v45" },
        { version: 46, migration_id: "v46-rowid-no-replace" },
        { version: 47, migration_id: "v47-owner-decision-authority-guard" },
        { version: 48, migration_id: "v48-owner-decision-supersede-guard" },
        { version: 49, migration_id: "v49-branch-publish-receipts" },
        { version: 50, migration_id: "v50-post-merge-verification-reentry" },
        { version: 52, migration_id: "v52-resident-project-provisioning" },
      ]);
    } finally {
      raw.close();
    }
  });

  it("B4: non-positive rows in two tables are each named with their count", () => {
    const path = privateStatePath("acp-v46-b4-two-");
    new Db(path).close();
    toV45Image(path);
    const legacy = foreignConnection(path);
    try {
      insert(legacy, "INSERT", SPECS[0]!, SPECS[0]!.row(1), 0);
      insert(legacy, "INSERT", SPECS[1]!, SPECS[1]!.row(1), -5);
      insert(legacy, "INSERT", SPECS[1]!, SPECS[1]!.row(2), -6);
      insert(legacy, "INSERT", SPECS[1]!, SPECS[1]!.row(3), -7);
    } finally {
      legacy.close();
    }
    const before = contentDigests(path);
    approveMigration(path, "V46 B4 two-table witness");
    let refusal: unknown;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    const reported = String((refusal as { evidence?: { migrationError?: unknown } } | undefined)?.evidence?.migrationError);
    expect(reported).toContain("outbox holds 1 row(s) with rowid <= 0");
    expect(reported).toContain("inbound_messages holds 3 row(s) with rowid <= 0");
    expect(reported).not.toContain("canonical_turns holds");
    expect(contentDigests(path)).toEqual(before);
  });

  it("D5-b: killed after v45 commits and before v46, the database is at v45 with the same inode; the [v45, v46] approval no longer names it, and a re-approval naming [v46] opens it", () => {
    const path = privateStatePath("acp-v46-d5b-");
    new Db(path).close();
    toV45Image(path);
    toV44Image(path);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V44_SCHEMA_DIGEST_FROM_V43);
    const inode = statSync(path).ino;
    const approved = approveMigration(path, "V46 D5-b witness");
    expect(approved).toMatchObject({
      fromVersion: 44,
      toVersion: SCHEMA_VERSION,
      migrations: ["v45-first-manifest-activation", "v46-rowid-no-replace", "v47-owner-decision-authority-guard", "v48-owner-decision-supersede-guard", "v49-branch-publish-receipts", "v50-post-merge-verification-reentry", "v52-resident-project-provisioning"],
    });
    const databaseModule = new URL("../../src/db/database.ts", import.meta.url).href;
    const child = boundedSpawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const { Db } = await import(${JSON.stringify(databaseModule)});
         new Db(${JSON.stringify(path)}, { afterMigration: (m) => { if (m.toVersion === 45) process.kill(process.pid, "SIGKILL"); } });`,
      ],
      { encoding: "utf8" },
    );
    expect(child.signal).toBe("SIGKILL");
    expect(statSync(path).ino).toBe(inode);
    expect(contentDigests(path).userVersion).toBe(45);
    // No restore ran: the v45 step's receipt is there, and the v46 triggers are not.
    const probe = new Database(path, { readonly: true });
    try {
      expect(probe.prepare("SELECT migration_id FROM schema_migrations WHERE version = 45").pluck().get()).toBe("v45-first-manifest-activation");
      expect(probe.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 46").pluck().get()).toBe(0);
      const triggers = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").pluck().all() as string[];
      for (const name of V46_ADDED_TRIGGERS) expect(triggers).not.toContain(name);
    } finally {
      probe.close();
    }
    expect(() => new Db(path)).toThrowError(/does not name the migration this start would perform/);
    expect(statSync(path).ino).toBe(inode);
    expect(contentDigests(path).userVersion).toBe(45);

    expect(approveMigration(path, "V46 D5-b re-approval")).toMatchObject({
      fromVersion: 45,
      toVersion: SCHEMA_VERSION,
      migrations: ["v46-rowid-no-replace", "v47-owner-decision-authority-guard", "v48-owner-decision-supersede-guard", "v49-branch-publish-receipts", "v50-post-merge-verification-reentry", "v52-resident-project-provisioning"],
    });
    new Db(path).close();
    expect(contentDigests(path).userVersion).toBe(SCHEMA_VERSION);
    expect(existsSync(migrationApprovalPath(path))).toBe(false);
  });

  it("an image that already holds all nine v46 triggers exactly as schema.sql defines them is accepted, and a repeated application changes nothing", () => {
    const path = privateStatePath("acp-v46-exact-");
    new Db(path).close();
    const definitions = schemaRowsOf(path).filter((row) => V46_ADDED_TRIGGERS.includes(row.name));
    expect(definitions).toHaveLength(9);
    toV45Image(path);
    const raw = new Database(path);
    try {
      for (const definition of definitions) raw.exec(definition.sql!);
    } finally {
      raw.close();
    }
    approveMigration(path, "V46-R1-01 exact pre-existing definitions");
    new Db(path).close();
    const before = contentDigests(path);
    const repeat = new Database(path);
    try {
      MIGRATIONS.find((migration) => migration.toVersion === 46)!.apply(repeat);
    } finally {
      repeat.close();
    }
    expect(contentDigests(path)).toEqual(before);
  });
});

/**
 * V46-R1-01. Whatever already holds a v46 name must be the trigger schema.sql defines: its type, its
 * table, its exact name and its definition, token for token. Anything else refuses the step, and the
 * contaminated v45 image is restored byte for byte, with no v46 receipt. The review's witnesses, changed
 * only for paths and isolation, plus two siblings: a view, and an upper-case name with the exact body.
 *
 * RED at 404422d5: v46 dropped and recreated its triggers, so `DROP TRIGGER IF EXISTS` replaced a
 * weakened body, a trigger on another table and an upper-case name, and an index or a view of the name
 * stayed beside the new guard; every open succeeded.
 */
const V46_TABLE_OF = (name: string): { table: string; sentinel: string } =>
  name.startsWith("outbox_") ? { table: "outbox", sentinel: "OUTBOX_NO_REPLACE" }
    : name.startsWith("inbound_messages_") ? { table: "inbound_messages", sentinel: "INBOUND_MESSAGE_NO_REPLACE" }
      : { table: "canonical_turns", sentinel: "CANONICAL_TURN_NO_REPLACE" };

describe.each(V46_ADDED_TRIGGERS)("V46-R1-01: a contaminated %s", (name) => {
  it.each(["weakened body", "wrong table", "index", "view", "upper-case name", "upper-case name with the exact body"])(
    "refuses a %s and restores the contaminated v45 image, with no v46 receipt",
    (variant) => {
      const fresh = privateStatePath("acp-v46-contaminated-fresh-");
      new Db(fresh).close();
      const exact = schemaRowsOf(fresh).find((row) => row.name === name)!.sql!;
      const path = privateStatePath("acp-v46-contaminated-");
      new Db(path).close();
      toV45Image(path);
      const { table, sentinel } = V46_TABLE_OF(name);
      const weakened = (on: string, as: string): string =>
        `CREATE TRIGGER ${as} AFTER INSERT ON ${on} WHEN 0 BEGIN SELECT RAISE(ABORT, '${sentinel}'); END;`;
      const raw = new Database(path);
      try {
        if (variant === "weakened body") raw.exec(weakened(table, name));
        else if (variant === "wrong table") raw.exec(weakened("projects", name));
        else if (variant === "index") raw.exec(`CREATE INDEX ${name} ON outbox(message_id)`);
        else if (variant === "view") raw.exec(`CREATE VIEW ${name} AS SELECT 1`);
        else if (variant === "upper-case name") raw.exec(weakened(table, name.toUpperCase()));
        else raw.exec(exact.replace(name, name.toUpperCase()));
      } finally {
        raw.close();
      }
      const contaminated = contentDigests(path);
      approveMigration(path, "V46-R1-01 contamination witness");
      let refusal: unknown;
      try {
        new Db(path).close();
      } catch (error) {
        refusal = error;
      }
      expect(String(refusal)).toMatch(/original database was restored/);
      expect(String((refusal as { evidence?: { migrationError?: unknown } } | undefined)?.evidence?.migrationError))
        .toMatch(new RegExp(`^v46 refuses: ${name} is held by the`));
      expect(contentDigests(path)).toEqual(contaminated);
      const probe = new Database(path, { readonly: true });
      try {
        expect(probe.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 46").pluck().get()).toBe(0);
      } finally {
        probe.close();
      }
    },
  );
});
