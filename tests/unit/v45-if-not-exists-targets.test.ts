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
import { V45_ADDED_TRIGGERS, digestOfSchemaRows, privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { V45_REPLACED_TRIGGERS, contentDigests, toV44Image } from "../helpers/released-v45-schema.ts";

afterAll(cleanupTempDirs);

/**
 * V45-R1-01 — every name a v45 `IF NOT EXISTS` statement creates is held, before the step and after
 * it, by exactly the object schema.sql defines under it: the first-grant table, its partial unique
 * index and the ten guards.
 *
 * `IF NOT EXISTS` is a no-op whenever anything already holds the name — an index of it on another
 * table, the same name in another letter case, a view in the table's place — and `DROP TRIGGER IF
 * EXISTS` removes whatever trigger holds a guard's name. The review measured the first at dce20a42:
 * an index of the unique index's name on `projects` let v45 commit, receipt and all, with no partial
 * unique index on the grant table, and two first grants were then consumed for one NULL project.
 *
 * A conflict is refused and the contaminated v44 image restored as it was, with no v45 receipt; it is
 * never dropped and recreated. The neighbouring cases the review found correct stay accepted.
 *
 * At dce20a42 the counterexample, its consequence and five of the conflicts below were accepted. The
 * review's sibling (the exact table with the index name on `projects`) and the view were refused there
 * too, for other reasons (a whole-table mismatch; a view cannot be indexed), so those two are red there
 * only on the reason they assert. The three accepted cases pass at dce20a42 and after.
 */

const TABLE = "manifest_first_activation_grants";
const INDEX = "manifest_first_activation_grants_one_consumed_per_project";

/** A fresh v45 database's stored definition of each v45 object, by name. */
const freshV45 = (() => {
  let cached: { path: string; sql: Map<string, string> } | undefined;
  return () => {
    if (cached) return cached;
    const path = privateStatePath("acp-v45-r1-fresh-");
    new Db(path).close();
    const raw = new Database(path, { readonly: true });
    try {
      const rows = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE name IN (${[TABLE, INDEX, ...V45_ADDED_TRIGGERS, ...V45_REPLACED_TRIGGERS].map(() => "?").join(", ")})`)
        .all(TABLE, INDEX, ...V45_ADDED_TRIGGERS, ...V45_REPLACED_TRIGGERS) as Array<{ name: string; sql: string }>;
      cached = { path, sql: new Map(rows.map((row) => [row.name, row.sql])) };
    } finally {
      raw.close();
    }
    return cached;
  };
})();

const v45Sql = (name: string): string => {
  const sql = freshV45().sql.get(name);
  if (sql === undefined) throw new Error(`${name} is not in a fresh v45 database`);
  return sql;
};

/** A v44 image with `plant` applied to it, approved; and the contaminated image's digests. */
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
  approveMigration(path, `V45-R1-01 witness ${prefix}`);
  return { path, contaminated };
};

/** Opening refuses the step for `reason`; the restore gives back the contaminated v44 image with no v45 receipt. */
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
  const raw = new Database(path, { readonly: true });
  try {
    expect(raw.pragma("user_version", { simple: true })).toBe(44);
    expect(raw.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 45").pluck().get()).toBe(0);
  } finally {
    raw.close();
  }
};

/** Opening takes the step; the schema is a fresh v45 install's, row for row. */
const expectAccepted = (path: string): void => {
  new Db(path).close();
  expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(digestOfSchemaRows(schemaRowsOf(freshV45().path)));
  const raw = new Database(path, { readonly: true });
  try {
    expect(raw.pragma("user_version", { simple: true })).toBe(45);
    expect(raw.prepare("SELECT migration_id FROM schema_migrations WHERE version = 45").pluck().get()).toBe("v45-first-manifest-activation");
  } finally {
    raw.close();
  }
};

/**
 * The review's consequence probe: two pre-issued first grants for one still-NULL project, then both
 * consumed. Changed only for paths and isolation; returns how many ended consumed, or the refusal.
 */
const consumeTwoFirstGrants = async (path: string, projectId: string): Promise<{ consumed: number; refusal?: string }> => {
  const h = makeHarness({ root: dirname(path) });
  try {
    const p = await operatorRegisteredProject(h, projectId);
    const ceo = () => h.cp.bindings.active(roleKeyFor(Role.CEO))!;
    for (let i = 1; i <= 2; i++) {
      const run = await createRun(h, p.projectId, RunKind.CONTRACT_CHANGE);
      const row: Record<string, unknown> = {
        grant_id: `g${i}`, run_id: run.runId, project_id: p.projectId, run_kind: "CONTRACT_CHANGE",
        registration_event_id: p.registrationEventId, manifest_digest: `sha256:m${i}`, plan_digest: "p",
        candidate_snapshot_digest: "c", packet_digest: "p", review_digest: "r",
        workflow_revisions_json: '[{"bound":"placeholder"}]', workflow_revisions_digest: "sha256:w",
        ceo_assignment_id: ceo().assignmentId, ceo_actor_id: "actor", ceo_session_id: ceo().sessionId,
        ceo_session_incarnation: ceo().sessionIncarnation, ceo_binding_generation: ceo().bindingGeneration,
        issued_at: "t", grant_digest: `sha256:g${i}`, consumer_session_id: ceo().sessionId,
        consumer_session_incarnation: ceo().sessionIncarnation, consumer_bound_at: "t",
      };
      const cols = Object.keys(row);
      h.cp.db.run(`INSERT INTO manifest_first_activation_grants (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, Object.values(row));
    }
    let refusal: string | undefined;
    for (let i = 1; i <= 2; i++) {
      try {
        h.cp.db.run("UPDATE manifest_first_activation_grants SET consumed_at='t',consumed_attempt_id=? WHERE grant_id=?", [`a${i}`, `g${i}`]);
      } catch (error) {
        refusal = (error as Error).message;
      }
    }
    const consumed = h.cp.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM manifest_first_activation_grants WHERE project_id = ? AND consumed_at IS NOT NULL",
      [p.projectId],
    )!.n;
    expect(h.cp.projects.require(p.projectId).activeManifestDigest).toBeNull();
    return refusal === undefined ? { consumed } : { consumed, refusal };
  } finally {
    h.cp.close();
  }
};

/** The refusal naming what holds a v45 name instead of the object schema.sql defines under it. */
const heldBy = (name: string, type: string, holder: string, table: string): RegExp =>
  new RegExp(`v45 refuses: ${name} is held by the ${type} ${holder} on ${table}, which is not`);

const indexOnProjects = (name = INDEX) => (raw: Database.Database) =>
  raw.exec(`CREATE UNIQUE INDEX ${name} ON projects(project_id)`);
const exactEmptyTable = (raw: Database.Database) => raw.exec(v45Sql(TABLE));

describe("V45-R1-01: the review's counterexample and its consequence", () => {
  it("an index holding the unique index's name on projects, with no first-grant table, is refused; the contaminated v44 image is restored with no v45 receipt", () => {
    const { path, contaminated } = plantedV44("acp-v45-r1-index-only-", indexOnProjects());
    expectRefusedAndPreserved(path, contaminated, heldBy(INDEX, "index", INDEX, "projects"));
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT tbl_name FROM sqlite_master WHERE name = ?").pluck().get(INDEX)).toBe("projects");
      expect(raw.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = ?").pluck().get(TABLE)).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("the consequence: on that image no first grant can be written at all; a normal upgrade admits one consumption per NULL project and refuses the second", async () => {
    const { path } = plantedV44("acp-v45-r1-consequence-", indexOnProjects());
    expect(() => new Db(path)).toThrowError(/original database was restored/);

    const normal = plantedV44("acp-v45-r1-normal-", () => {});
    new Db(normal.path).close();
    const raw = new Database(normal.path, { readonly: true });
    try {
      expect(raw.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE name = ?").get(INDEX)).toEqual({ tbl_name: TABLE, sql: v45Sql(INDEX) });
      expect(raw.prepare("SELECT \"unique\", partial FROM pragma_index_list(?) WHERE name = ?").get(TABLE, INDEX)).toEqual({ unique: 1, partial: 1 });
    } finally {
      raw.close();
    }
    const outcome = await consumeTwoFirstGrants(normal.path, "index-conflict");
    expect(outcome.consumed).toBe(1);
    expect(outcome.refusal).toMatch(/UNIQUE constraint failed/);
  });
});

describe("V45-R1-01: a name a v45 target takes, held by anything else, refuses the step", () => {
  const cases: ReadonlyArray<[string, (raw: Database.Database) => void, RegExp]> = [
    ["the unique index's name in another letter case, on projects", indexOnProjects(INDEX.toUpperCase()), heldBy(INDEX, "index", INDEX.toUpperCase(), "projects")],
    ["a view in the first-grant table's place", (raw) => raw.exec(`CREATE VIEW ${TABLE} AS SELECT project_id FROM projects`), heldBy(TABLE, "view", TABLE, TABLE)],
    [
      "a first-grant guard's name held by a trigger on projects",
      (raw) => raw.exec("CREATE TRIGGER manifest_first_activation_grants_no_delete BEFORE DELETE ON projects BEGIN SELECT 1; END"),
      heldBy("manifest_first_activation_grants_no_delete", "trigger", "manifest_first_activation_grants_no_delete", "projects"),
    ],
    [
      "the v44 grant table's new guard's name held by a body v45 does not define",
      (raw) => raw.exec("CREATE TRIGGER manifest_activation_grants_not_first BEFORE INSERT ON manifest_activation_grants BEGIN SELECT 1; END"),
      heldBy("manifest_activation_grants_not_first", "trigger", "manifest_activation_grants_not_first", "manifest_activation_grants"),
    ],
    [
      "a guard v45 replaces, holding neither v44's body nor v45's",
      (raw) => raw.exec(`DROP TRIGGER projects_active_manifest_moves_by_grant;
        CREATE TRIGGER projects_active_manifest_moves_by_grant BEFORE UPDATE OF active_manifest_digest ON projects BEGIN SELECT 1; END`),
      heldBy("projects_active_manifest_moves_by_grant", "trigger", "projects_active_manifest_moves_by_grant", "projects"),
    ],
    [
      "the exact empty first-grant table with the unique index's name on projects (the review's sibling)",
      (raw) => {
        exactEmptyTable(raw);
        indexOnProjects()(raw);
      },
      heldBy(INDEX, "index", INDEX, "projects"),
    ],
    [
      "the exact empty first-grant table carrying a guard v45 does not define",
      (raw) => {
        exactEmptyTable(raw);
        raw.exec(`CREATE TRIGGER planted_ignore BEFORE UPDATE ON ${TABLE} BEGIN SELECT RAISE(IGNORE); END`);
      },
      new RegExp(`v45 refuses: ${TABLE} carries .*trigger planted_ignore`),
    ],
  ];

  it.each(cases)("%s", (_what, plant, reason) => {
    const { path, contaminated } = plantedV44("acp-v45-r1-conflict-", plant);
    expectRefusedAndPreserved(path, contaminated, reason);
  });
});

describe("V45-R1-01: what is already exactly v45's is accepted, never repaired", () => {
  it("the exact empty first-grant table without its index receives the index on it (the review's sibling)", () => {
    const { path } = plantedV44("acp-v45-r1-table-only-", exactEmptyTable);
    expectAccepted(path);
  });

  it("the exact empty first-grant table with its exact index is accepted", () => {
    const { path } = plantedV44("acp-v45-r1-table-index-", (raw) => {
      exactEmptyTable(raw);
      raw.exec(v45Sql(INDEX));
    });
    expectAccepted(path);
  });

  it("every v45 object already exactly v45's, the replaced guards included, is accepted", () => {
    const { path } = plantedV44("acp-v45-r1-all-exact-", (raw) => {
      exactEmptyTable(raw);
      raw.exec(v45Sql(INDEX));
      for (const name of V45_ADDED_TRIGGERS) raw.exec(v45Sql(name));
      for (const name of V45_REPLACED_TRIGGERS) raw.exec(`DROP TRIGGER ${name}; ${v45Sql(name)}`);
    });
    expectAccepted(path);
  });
});
