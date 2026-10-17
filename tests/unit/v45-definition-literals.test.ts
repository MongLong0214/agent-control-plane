import Database from "better-sqlite3";
import { dirname } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isAcpError } from "../../src/core/errors.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { createRun, operatorRegisteredProject } from "../helpers/first-activation.ts";
import { makeHarness } from "../helpers/harness.ts";
import { privateStatePath } from "../helpers/released-v44-schema.ts";
import { contentDigests, toV44Image } from "../helpers/released-v45-schema.ts";

afterAll(cleanupTempDirs);

/**
 * ROUND1-ESCAPE-01 — the v45 step compares an existing definition with schema.sql's with every
 * single-quoted literal byte for byte.
 *
 * At 1908b40e the comparison removed every double quote and collapsed whitespace across the whole
 * definition, literals included. The review planted a grant table whose CHECK read
 * `LIKE 'sha"256:%'`: v45 committed with its receipt and kept that CHECK, and a normal `sha256:` grant
 * then failed. It planted a `no_delete` guard with a changed error literal: v45 committed and dropped
 * and recreated it. Both are now refused, the contaminated v44 image is restored as it was, and no v45
 * receipt is written. The two review tests below are the review's, changed only for paths, isolation
 * and lint (its diagnostic output is the assertion message).
 *
 * The siblings must refuse as well: whitespace, `--`, a block comment or letter case changed inside a
 * literal, keywords double-quoted (`TEXT "NOT" "NULL"` is a column type, not a constraint) and a bracketed
 * identifier (refused by choice; nothing legitimate writes one). At 1908b40e the double-quoted keyword
 * was accepted; the others were refused there too, and stand against a comparison that reaches inside
 * a literal. The controls stay accepted: identifiers SQLite's own rename writes double-quoted, and
 * whitespace, comments and double quotes around plain names outside literals. At 1908b40e a block
 * comment was not removed, so its control was refused there; the others were accepted there too.
 */

const TABLE = "manifest_first_activation_grants";
const INDEX = "manifest_first_activation_grants_one_consumed_per_project";
const NO_DELETE = "manifest_first_activation_grants_no_delete";

/** The stored definitions of a fresh v45 database, by name. */
const freshV45Sql = (() => {
  let cached: Map<string, string> | undefined;
  return (name: string): string => {
    if (cached === undefined) {
      const path = privateStatePath("acp-v45-literal-fresh-");
      new Db(path).close();
      const raw = new Database(path, { readonly: true });
      try {
        cached = new Map((raw.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{ name: string; sql: string }>)
          .map((row) => [row.name, row.sql]));
      } finally {
        raw.close();
      }
    }
    const sql = cached.get(name);
    if (sql === undefined) throw new Error(`${name} is not in a fresh v45 database`);
    return sql;
  };
})();

const storedSql = (path: string, name: string): string | undefined => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(name) as string | undefined;
  } finally {
    raw.close();
  }
};

/** A replacement that must change `text`, so a witness never plants the exact definition by accident. */
const replaced = (text: string, from: string, to: string): string => {
  const altered = text.replace(from, to);
  expect(altered, `${from} is in the definition`).not.toBe(text);
  return altered;
};

/** A v44 image with `plant` applied, approved; and the contaminated image's digests. */
const plantedV44 = (prefix: string, plant: (raw: Database.Database) => void) => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  toV44Image(path);
  const raw = new Database(path);
  try {
    plant(raw);
  } finally {
    raw.close();
  }
  const contaminated = contentDigests(path);
  approveMigration(path, `ROUND1-ESCAPE-01 witness ${prefix}`);
  return { path, contaminated };
};

/** At v44 with no v45 receipt. */
const expectNoV45Receipt = (path: string): void => {
  const raw = new Database(path, { readonly: true });
  try {
    expect(raw.pragma("user_version", { simple: true })).toBe(44);
    expect(raw.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 45").pluck().get()).toBe(0);
  } finally {
    raw.close();
  }
};

/** Opening refuses the step for `reason`, and gives back the contaminated v44 image with no v45 receipt. */
const expectRefusedAndPreserved = (path: string, contaminated: ReturnType<typeof contentDigests>, reason: RegExp): void => {
  let refusal: unknown;
  try {
    new Db(path).close();
  } catch (error) {
    refusal = error;
  }
  expect(refusal, "the v44 → v45 step must be refused").toBeInstanceOf(Error);
  expect((refusal as Error).message).toMatch(/original database was restored/);
  expect(isAcpError(refusal) ? String(refusal.evidence["migrationError"]) : "").toMatch(reason);
  expect(contentDigests(path)).toEqual(contaminated);
  expectNoV45Receipt(path);
};

/** Opening takes the step and keeps the accepted table as it stood; its partial unique index is v45's. */
const expectAcceptedKeeping = (path: string, tableSql: string): void => {
  new Db(path).close();
  const raw = new Database(path, { readonly: true });
  try {
    expect(raw.pragma("user_version", { simple: true })).toBe(45);
    expect(raw.prepare("SELECT migration_id FROM schema_migrations WHERE version = 45").pluck().get()).toBe("v45-first-manifest-activation");
    expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(TABLE)).toBe(tableSql);
    expect(raw.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE name = ?").get(INDEX)).toEqual({ tbl_name: TABLE, sql: freshV45Sql(INDEX) });
    expect(raw.prepare("SELECT \"unique\", partial FROM pragma_index_list(?) WHERE name = ?").get(TABLE, INDEX)).toEqual({ unique: 1, partial: 1 });
    expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(NO_DELETE)).toBe(freshV45Sql(NO_DELETE));
  } finally {
    raw.close();
  }
};

const heldBy = (name: string, type: string, table: string): RegExp =>
  new RegExp(`v45 refuses: ${name} is held by the ${type} ${name} on ${table}, which is not`);

describe("ROUND1-ESCAPE-01: the review's two counterexamples", () => {
  /** The review's probe: one structural grant with a `sha256:` manifest digest, or the refusal. */
  const writeValidGrant = async (path: string, projectId: string) => {
    const h = makeHarness({ root: dirname(path) });
    try {
      const p = await operatorRegisteredProject(h, projectId);
      const run = await createRun(h, p.projectId, RunKind.CONTRACT_CHANGE);
      const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      const row = {
        grant_id: "g", run_id: run.runId, project_id: p.projectId, run_kind: "CONTRACT_CHANGE",
        registration_event_id: p.registrationEventId, manifest_digest: `sha256:${"a".repeat(64)}`, plan_digest: "p",
        candidate_snapshot_digest: "c", packet_digest: "p", review_digest: "r",
        workflow_revisions_json: '[{"bound":"placeholder"}]', workflow_revisions_digest: "sha256:w",
        ceo_assignment_id: ceo.assignmentId, ceo_actor_id: "actor", ceo_session_id: ceo.sessionId,
        ceo_session_incarnation: ceo.sessionIncarnation, ceo_binding_generation: ceo.bindingGeneration,
        issued_at: "t", grant_digest: "sha256:g", consumer_session_id: ceo.sessionId,
        consumer_session_incarnation: ceo.sessionIncarnation, consumer_bound_at: "t",
      };
      const cols = Object.keys(row);
      try {
        h.cp.db.run(`INSERT INTO manifest_first_activation_grants (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, Object.values(row));
        return { inserted: true };
      } catch (e) {
        return { inserted: false, error: String(e), evidence: (e as { evidence?: unknown }).evidence };
      }
    } finally {
      h.cp.close();
    }
  };

  it("an altered CHECK literal must refuse v45 and preserve the contaminated image", async () => {
    const path = privateStatePath("acp-review-v45-literal-");
    new Db(path).close();
    const source = new Database(path, { readonly: true });
    const ddl = source.prepare("SELECT sql FROM sqlite_master WHERE name = 'manifest_first_activation_grants'").pluck().get() as string;
    source.close();
    toV44Image(path);
    // Removing double quotes globally equates these different SQL string literals.
    const altered = ddl.replace("manifest_digest LIKE 'sha256:%'", "manifest_digest LIKE 'sha\"256:%'");
    expect(altered).not.toBe(ddl);
    const raw = new Database(path);
    raw.exec(altered);
    raw.close();
    const before = contentDigests(path);
    approveMigration(path, "review altered CHECK definition");
    let error: unknown;
    try { new Db(path).close(); } catch (e) { error = e; }
    let accepted = "";
    if (error === undefined) {
      const control = privateStatePath("acp-review-v45-literal-control-");
      new Db(control).close();
      toV44Image(control);
      approveMigration(control, "review literal control");
      new Db(control).close();
      const clean = await writeValidGrant(control, "literal-control");
      expect(clean.inserted).toBe(true);
      const contaminated = await writeValidGrant(path, "literal-conflict");
      const inspected = new Database(path, { readonly: true });
      accepted = JSON.stringify({ migrationAccepted: true, userVersion: inspected.pragma("user_version", { simple: true }),
        receipt: inspected.prepare("SELECT version, migration_id FROM schema_migrations WHERE version=45").get(),
        badCheckStillStored: String(inspected.prepare("SELECT sql FROM sqlite_master WHERE name = 'manifest_first_activation_grants'").pluck().get()).includes("sha\"256:%"),
        controlGrant: clean, contaminatedGrant: contaminated });
      inspected.close();
    }
    expect(error, `must reject the changed CHECK literal before writing v45 receipt ${accepted}`).toBeInstanceOf(Error);
    expect(contentDigests(path)).toEqual(before);
    expectNoV45Receipt(path);
    expect(isAcpError(error) ? String(error.evidence["migrationError"]) : "").toMatch(heldBy(TABLE, "table", TABLE));
  });

  it("an altered trigger literal must refuse v45, without dropping and recreating the conflicting trigger", () => {
    const path = privateStatePath("acp-review-v45-trigger-literal-");
    new Db(path).close();
    const source = new Database(path, { readonly: true });
    const table = source.prepare("SELECT sql FROM sqlite_master WHERE name = 'manifest_first_activation_grants'").pluck().get() as string;
    const name = "manifest_first_activation_grants_no_delete";
    const ddl = source.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(name) as string;
    source.close();
    toV44Image(path);
    const altered = ddl.replace("MANIFEST_GRANT_IMMUTABLE", "MANIFEST_GRANT_\"IMMUTABLE");
    expect(altered).not.toBe(ddl);
    const planted = new Database(path);
    planted.exec(table);
    planted.exec(altered);
    planted.close();
    const before = contentDigests(path);
    approveMigration(path, "review altered trigger literal");
    let error: unknown;
    try { new Db(path).close(); } catch (e) { error = e; }
    const after = new Database(path, { readonly: true });
    const outcome = JSON.stringify({ trigger: name, migrationAccepted: error === undefined,
      userVersion: after.pragma("user_version", { simple: true }),
      receipt: after.prepare("SELECT version, migration_id FROM schema_migrations WHERE version=45").get(),
      conflictingTriggerReplacedWithCanonical: after.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(name) === ddl,
      contaminatedImagePreserved: JSON.stringify(contentDigests(path)) === JSON.stringify(before) });
    after.close();
    expect(error, `must refuse rather than repair this conflicting definition ${outcome}`).toBeInstanceOf(Error);
    expect(contentDigests(path)).toEqual(before);
    expectNoV45Receipt(path);
    expect(storedSql(path, name), "the conflicting trigger is neither dropped nor recreated").toBe(altered);
    expect(isAcpError(error) ? String(error.evidence["migrationError"]) : "").toMatch(heldBy(NO_DELETE, "trigger", TABLE));
  });
});

describe("ROUND1-ESCAPE-01: a definition changed inside a quoted region refuses the step", () => {
  const onTable = (from: string, to: string) => (raw: Database.Database) => raw.exec(replaced(freshV45Sql(TABLE), from, to));
  const onGuard = (from: string, to: string) => (raw: Database.Database) => {
    raw.exec(freshV45Sql(TABLE));
    raw.exec(replaced(freshV45Sql(NO_DELETE), from, to));
  };
  const LIKE = "manifest_digest LIKE 'sha256:%'";
  const KIND = "run_kind = 'CONTRACT_CHANGE'";
  const RAISE = "'MANIFEST_GRANT_IMMUTABLE'";
  const table = heldBy(TABLE, "table", TABLE);
  const guard = heldBy(NO_DELETE, "trigger", TABLE);
  const cases: ReadonlyArray<[string, (raw: Database.Database) => void, RegExp]> = [
    ["whitespace inside a CHECK literal", onTable(KIND, "run_kind = 'CONTRACT_CHANGE '"), table],
    ["whitespace inside a guard's error literal", onGuard(RAISE, "'MANIFEST_GRANT_IMMUTABLE '"), guard],
    ["`--` inside a CHECK literal", onTable(LIKE, "manifest_digest LIKE 'sha256:%--'"), table],
    ["`--` inside a guard's error literal", onGuard(RAISE, "'MANIFEST_GRANT_IMMUTABLE--'"), guard],
    ["a block comment inside a CHECK literal", onTable(LIKE, "manifest_digest LIKE 'sha256:/**/%'"), table],
    ["letter case inside a CHECK literal", onTable("= 'array'", "= 'ARRAY'"), table],
    ["letter case inside a guard's error literal", onGuard(RAISE, "'manifest_grant_immutable'"), guard],
    [
      "double-quoted keywords: `TEXT \"NOT\" \"NULL\" \"UNIQUE\"` is a column type, and run_id loses NOT NULL and UNIQUE",
      onTable("TEXT NOT NULL UNIQUE REFERENCES runs", "TEXT \"NOT\" \"NULL\" \"UNIQUE\" REFERENCES runs"),
      table,
    ],
    ["a bracketed identifier", onTable("REFERENCES projects(project_id)", "REFERENCES [projects](project_id)"), table],
  ];

  it.each(cases)("%s", (_what, plant, reason) => {
    const { path, contaminated } = plantedV44("acp-v45-literal-sibling-", plant);
    expectRefusedAndPreserved(path, contaminated, reason);
  });
});

describe("ROUND1-ESCAPE-01: what differs only outside literals, as SQLite reads it, is accepted", () => {
  it("identifiers SQLite's own rename wrote double-quoted, in the table and in v44's guards, are accepted and the table kept", () => {
    let tableSql = "";
    const { path } = plantedV44("acp-v45-literal-renamed-", (raw) => {
      raw.exec(freshV45Sql(TABLE));
      raw.exec("ALTER TABLE projects RENAME TO projects_renamed; ALTER TABLE projects_renamed RENAME TO projects;");
      tableSql = raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(TABLE) as string;
      expect(tableSql).toContain("REFERENCES \"projects\"(project_id)");
      expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'projects_active_manifest_moves_by_grant'").pluck().get()).toContain("ON \"projects\"");
    });
    expectAcceptedKeeping(path, tableSql);
  });

  it("whitespace, `--` comments and double quotes around plain names, outside literals, are accepted and the table kept", () => {
    const tableSql = replaced(replaced(replaced(freshV45Sql(TABLE),
      "REFERENCES runs(run_id),", "REFERENCES \"runs\"(\"run_id\"),  -- planted, 'not a literal'"),
      "ceo_binding_generation > 0", "ceo_binding_generation\t>\n0"),
      ") WITHOUT ROWID", ")\n\n  WITHOUT   ROWID");
    const { path } = plantedV44("acp-v45-literal-spacing-", (raw) => {
      raw.exec(tableSql);
      raw.exec(replaced(freshV45Sql(NO_DELETE), "BEGIN\n", "BEGIN -- planted\n\t"));
    });
    expectAcceptedKeeping(path, tableSql);
  });

  it("block comments outside literals are accepted and the table kept", () => {
    const tableSql = replaced(freshV45Sql(TABLE), "(\n  grant_id", "( /* planted, 'not a literal' */\n\tgrant_id");
    const { path } = plantedV44("acp-v45-literal-block-comment-", (raw) => {
      raw.exec(tableSql);
      raw.exec(replaced(freshV45Sql(NO_DELETE), "BEGIN\n", "BEGIN /* planted */\n"));
    });
    expectAcceptedKeeping(path, tableSql);
  });
});
