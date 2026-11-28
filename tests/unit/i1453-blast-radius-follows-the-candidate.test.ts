import { describe, expect, it } from "vitest";

import { manifestDigest, projectManifestSchema, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { digestOf } from "../../src/core/digest.ts";
import {
  classifyBlastRadius,
  parseAddedBlocks,
  pathsOutsideContract,
  type BlastRadiusDeclaration,
  type BlastRadiusRepositoryChange,
} from "../../src/snapshot/blast-radius.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  candidateSnapshotSchema,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import { fixtureManifest } from "../helpers/harness.ts";

/**
 * #1453 PR A — the lane follows what the frozen candidate does, not what its goal says: the pure
 * classifier over a candidate's added lines and paths, and the optional manifest and snapshot keys.
 */

/** One repository's change: `added` maps a path to its added lines, numbered from 1. */
const change = (
  added: Record<string, string>,
  options: { role?: string; touched?: string[]; deleted?: string[] } = {},
): BlastRadiusRepositoryChange => ({
  repositoryRole: options.role ?? "primary",
  touchedPaths: options.touched ?? Object.keys(added),
  deletedPaths: options.deleted ?? [],
  addedLines: Object.fromEntries(Object.entries(added).map(([path, text]) => [path, [{ line: 1, text: text.split("\n") }]])),
});

const classify = (
  repositories: BlastRadiusRepositoryChange[],
  declared?: Partial<BlastRadiusDeclaration>,
  textItems: string[] = [],
) => classifyBlastRadius({ repositories, declared: declared === undefined ? undefined : { wide: [], irreversible: [], migrations: [], ...declared }, textItems });

describe("#1453 classifier: destructive statements in schema files are IRREVERSIBLE", () => {
  it.each([
    ["DROP TABLE users;", "DROP_TABLE", "users"],
    ["drop table if exists Users;", "DROP_TABLE", "Users"],
    ["DROP SCHEMA reporting CASCADE;", "DROP_SCHEMA", "reporting"],
    ["DROP DATABASE legacy;", "DROP_DATABASE", "legacy"],
    ["ALTER TABLE users DROP COLUMN email;", "ALTER_TABLE_DROP", "email"],
    ["ALTER TABLE users\n  DROP COLUMN email;", "ALTER_TABLE_DROP", "email"],
    ["TRUNCATE TABLE sessions;", "TRUNCATE", "sessions"],
    ["truncate sessions;", "TRUNCATE", "sessions"],
    ["DELETE FROM sessions;", "DELETE_WITHOUT_WHERE", "sessions"],
    ["SELECT 1; DELETE FROM \"sessions\"", "DELETE_WITHOUT_WHERE", "sessions"],
  ])("%s", (sql, kind, name) => {
    const result = classify([change({ "db/0002.sql": `-- change\n${sql}\n` })]);
    expect(result.lane).toBe("IRREVERSIBLE");
    expect(result.items).toEqual([expect.objectContaining({ kind, name, repositoryRole: "primary", path: "db/0002.sql" })]);
  });

  it("names the line a statement starts on", () => {
    const result = classifyBlastRadius({
      repositories: [{ repositoryRole: "primary", touchedPaths: ["schema.sql"], deletedPaths: [],
        addedLines: { "schema.sql": [{ line: 40, text: ["CREATE INDEX a ON t(x);", "", "DROP TABLE orders;"] }] } }],
      textItems: [],
    });
    expect(result.items).toEqual([{ kind: "DROP_TABLE", repositoryRole: "primary", path: "schema.sql", line: 42, name: "orders" }]);
  });

  it("reads SQL embedded in code under a declared migrations path", () => {
    const result = classify(
      [change({ "src/db/migrations.ts": "    raw.exec(`DROP TABLE IF EXISTS canonical_turns`);" })],
      { migrations: [{ repositoryRole: "primary", path: "src/db/migrations.ts" }] },
    );
    expect(result).toEqual({ lane: "IRREVERSIBLE", items: [expect.objectContaining({ kind: "DROP_TABLE", name: "canonical_turns", line: 1 })] });
  });

  it("ignores the same SQL in a file that is neither *.sql nor under a migrations path", () => {
    expect(classify([change({ "src/app.ts": "raw.exec(`DROP TABLE users`);" })])).toEqual({ lane: "CONTAINED", items: [] });
  });

  it("a declared migrations path is a prefix, not a substring", () => {
    const declared = { migrations: [{ repositoryRole: "primary", path: "db/migrate/" }] };
    expect(classify([change({ "db/migrate2/001.rb": 'execute "DROP TABLE users"' })], declared).lane).toBe("CONTAINED");
    expect(classify([change({ "db/migrate/001.rb": 'execute "DROP TABLE users"' })], declared).lane).toBe("IRREVERSIBLE");
  });

  it("a declaration applies to its own repository role only", () => {
    const declared = { migrations: [{ repositoryRole: "api", path: "migrate" }] };
    expect(classify([change({ "migrate/001.rb": 'execute "DROP TABLE users"' })], declared).lane).toBe("CONTAINED");
  });
});

describe("#1453 classifier: what is not IRREVERSIBLE", () => {
  it("a table rebuild (DROP then RENAME TO or CREATE TABLE the same name) is WIDE", () => {
    const renamed = classify([change({ "db/0003.sql": "CREATE TABLE runs_new (id TEXT);\nDROP TABLE runs;\nALTER TABLE runs_new RENAME TO runs;" })]);
    expect(renamed).toEqual({ lane: "WIDE", items: [{ kind: "SCHEMA_CHANGE", repositoryRole: "primary", path: "db/0003.sql" }] });
    const recreated = classify([change({ "db/0003.sql": "DROP TABLE IF EXISTS cache;\nCREATE TABLE IF NOT EXISTS cache (k TEXT);" })]);
    expect(recreated.lane).toBe("WIDE");
  });

  it("a rebuild of one table does not excuse dropping another", () => {
    const result = classify([change({ "db/0003.sql": "DROP TABLE runs, users;\nALTER TABLE runs_new RENAME TO runs;" })]);
    expect(result.lane).toBe("IRREVERSIBLE");
    expect(result.items.map((item) => item.name)).toEqual(["users"]);
  });

  it("DELETE with a WHERE clause, on its line or a later one, is WIDE", () => {
    expect(classify([change({ "db/0004.sql": "DELETE FROM sessions WHERE expired = 1;" })]).lane).toBe("WIDE");
    expect(classify([change({ "db/0004.sql": "DELETE FROM sessions\n  WHERE expired = 1;" })]).lane).toBe("WIDE");
  });

  it("a WHERE in a comment, or in the next statement, does not qualify a DELETE", () => {
    expect(classify([change({ "db/0004.sql": "DELETE FROM sessions -- WHERE expired = 1\n;" })]).lane).toBe("IRREVERSIBLE");
    expect(classify([change({ "src/db/m.sql": "DELETE FROM a; DELETE FROM b WHERE x = 1;" })]).items.map((i) => i.name)).toEqual(["a"]);
  });

  it("identifiers and prose that only contain the words are not statements", () => {
    const sql = [
      "CREATE TABLE results (",
      "  output_truncated INTEGER NOT NULL,",
      "  truncated BOOLEAN,",
      "  drop_reason TEXT",
      ");",
      "-- we never DROP TABLE users here",
      "/* DELETE FROM users */",
      "ALTER TABLE results ADD COLUMN dropped_at TEXT;",
    ].join("\n");
    expect(classify([change({ "db/0005.sql": sql })])).toEqual({ lane: "WIDE", items: [{ kind: "SCHEMA_CHANGE", repositoryRole: "primary", path: "db/0005.sql" }] });
  });

  it("a plain file deletion is CONTAINED: git revert restores it", () => {
    expect(classify([change({}, { touched: ["src/old.js"], deleted: ["src/old.js"] })])).toEqual({ lane: "CONTAINED", items: [] });
  });

  it("a file deleted under a declared migrations path is IRREVERSIBLE", () => {
    const result = classify(
      [change({}, { touched: ["db/migrate/001.sql"], deleted: ["db/migrate/001.sql"] })],
      { migrations: [{ repositoryRole: "primary", path: "db/migrate" }] },
    );
    expect(result).toEqual({ lane: "IRREVERSIBLE", items: [{ kind: "MIGRATION_DELETED", repositoryRole: "primary", path: "db/migrate/001.sql" }] });
  });
});

describe("#1453 classifier: declared paths and text items", () => {
  it("a touched declared wide path is WIDE", () => {
    const result = classify([change({ "src/auth/session.ts": "x" })], { wide: [{ repositoryRole: "primary", path: "src/auth" }] });
    expect(result).toEqual({ lane: "WIDE", items: [{ kind: "WIDE_PATH", repositoryRole: "primary", path: "src/auth/session.ts" }] });
  });

  it("a touched declared irreversible path is IRREVERSIBLE, and outranks WIDE", () => {
    const result = classify(
      [change({ "infra/bucket.tf": "x", "src/auth/a.ts": "y" })],
      { wide: [{ repositoryRole: "primary", path: "src/auth" }], irreversible: [{ repositoryRole: "primary", path: "infra" }] },
    );
    expect(result).toEqual({ lane: "IRREVERSIBLE", items: [{ kind: "IRREVERSIBLE_PATH", repositoryRole: "primary", path: "infra/bucket.tf" }] });
  });

  it("a text item is IRREVERSIBLE whatever the diff", () => {
    expect(classify([change({ "src/app.js": "x" })], undefined, ["destructive data migration or delete"])).toEqual({
      lane: "IRREVERSIBLE",
      items: [{ kind: "TEXT", name: "destructive data migration or delete" }],
    });
  });

  it("a candidate that touches nothing declared and no schema is CONTAINED", () => {
    expect(classify([change({ "src/app.js": "module.exports = () => 2;" })])).toEqual({ lane: "CONTAINED", items: [] });
  });
});

describe("#1453 parseAddedBlocks reads a -U0 patch", () => {
  it("numbers each added block from its hunk header, skipping headers and removals", () => {
    const patch = [
      "diff --git a/db/s.sql b/db/s.sql",
      "index 1111111..2222222 100644",
      "--- a/db/s.sql",
      "+++ b/db/s.sql",
      "@@ -3 +3,2 @@",
      "-old line",
      "+DROP TABLE users;",
      "+-- done",
      "@@ -10,0 +12 @@",
      "+TRUNCATE t;",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parseAddedBlocks(patch)).toEqual([
      { line: 3, text: ["DROP TABLE users;", "-- done"] },
      { line: 12, text: ["TRUNCATE t;"] },
    ]);
  });
});

describe("#1453 pathsOutsideContract: a destructive path change ships alone", () => {
  const declared: BlastRadiusDeclaration = { wide: [], irreversible: [{ repositoryRole: "primary", path: "infra" }], migrations: [{ repositoryRole: "primary", path: "migrations" }] };
  const repositories = (paths: string[]) => [{ repositoryRole: "primary", touchedPaths: paths }];

  it("names every touched path outside migrations, irreversible paths and the matched .sql files", () => {
    const radius = classifyBlastRadius({ repositories: [change({ "migrations/0002.sql": "DROP TABLE users;", "src/app.js": "x" })], declared, textItems: [] });
    expect(pathsOutsideContract(radius, repositories(["migrations/0002.sql", "src/app.js"]), declared)).toEqual([{ repositoryRole: "primary", path: "src/app.js" }]);
    const sql = classifyBlastRadius({ repositories: [change({ "db/9.sql": "DROP TABLE users;", "db/other.sql": "CREATE TABLE x (a INT);" })], declared, textItems: [] });
    expect(pathsOutsideContract(sql, repositories(["db/9.sql", "db/other.sql"]), declared)).toEqual([{ repositoryRole: "primary", path: "db/other.sql" }]);
  });

  it("an isolated destructive change, a text-only lane and a WIDE lane are not mixed", () => {
    const isolated = classifyBlastRadius({ repositories: [change({ "migrations/0002.sql": "DROP TABLE users;", "infra/x.tf": "y" })], declared, textItems: [] });
    expect(pathsOutsideContract(isolated, repositories(["infra/x.tf", "migrations/0002.sql"]), declared)).toEqual([]);
    const text = classifyBlastRadius({ repositories: [change({ "src/app.js": "x" })], declared, textItems: ["irreversible production action"] });
    expect(pathsOutsideContract(text, repositories(["src/app.js"]), declared)).toEqual([]);
    const wide = classifyBlastRadius({ repositories: [change({ "db/1.sql": "CREATE TABLE x (a INT);", "src/app.js": "x" })], declared, textItems: [] });
    expect(pathsOutsideContract(wide, repositories(["db/1.sql", "src/app.js"]), declared)).toEqual([]);
  });
});

describe("#1453 the manifest and snapshot keys are optional, and digests without them are unchanged", () => {
  const base = fixtureManifest("p");

  it("a manifest without blastRadius parses without the key, so its digest is the one it always had", () => {
    const parsed = projectManifestSchema.parse(base);
    expect(Object.prototype.hasOwnProperty.call(parsed, "blastRadius")).toBe(false);
    expect(manifestDigest(parsed)).toBe(manifestDigest(projectManifestSchema.parse(JSON.parse(JSON.stringify(base)))));
  });

  const withRecovery = (mode: "TRUSTED_CI" | "LOCAL_COMMAND" | "BOTH_REQUIRED", extra: Partial<ProjectManifest> = {}): unknown => ({
    ...base,
    verificationCommands: [
      ...base.verificationCommands,
      { ...base.verificationCommands[0]!, id: "db-backup", evidenceMode: mode },
      { ...base.verificationCommands[0]!, id: "db-restore-check", evidenceMode: "TRUSTED_CI" },
    ],
    blastRadius: {
      migrations: [{ repositoryRole: "primary", path: "migrations" }],
      recovery: [{ repositoryRole: "primary", backupCommand: "db-backup", restoreCheckCommand: "db-restore-check" }],
    },
    ...extra,
  });

  it("a declared blastRadius parses, with contractDelayHours 24 when absent", () => {
    const parsed = projectManifestSchema.parse(withRecovery("BOTH_REQUIRED"));
    expect(parsed.blastRadius).toEqual({
      wide: [], irreversible: [], migrations: [{ repositoryRole: "primary", path: "migrations" }], contractDelayHours: 24,
      recovery: [{ repositoryRole: "primary", backupCommand: "db-backup", restoreCheckCommand: "db-restore-check" }],
    });
  });

  it("refuses a backup ACP would have to run itself, an unknown command, an unknown role and a non-normal path", () => {
    expect(projectManifestSchema.safeParse(withRecovery("LOCAL_COMMAND")).success).toBe(false);
    const declared = (blastRadius: unknown) => projectManifestSchema.safeParse({ ...base, blastRadius }).success;
    expect(declared({ recovery: [{ repositoryRole: "primary", backupCommand: "nope", restoreCheckCommand: "verify" }] })).toBe(false);
    expect(declared({ wide: [{ repositoryRole: "api", path: "src" }] })).toBe(false);
    for (const path of ["/abs", "../up", "a/../b", "./src", "a//b", "."]) {
      expect(declared({ irreversible: [{ repositoryRole: "primary", path }] }), path).toBe(false);
    }
    expect(declared({ contractDelayHours: 0 })).toBe(false);
    expect(declared({ migrations: [{ repositoryRole: "primary", path: "db/migrate/" }] })).toBe(true);
  });

  const snapshot = (extra: Record<string, unknown> = {}): CandidateSnapshot => candidateSnapshotSchema.parse({
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId: "run_1",
    contractDigest: "sha256:contract",
    repositories: [],
    createdAt: "2026-11-28T00:00:00.000Z",
    ...extra,
  });

  it("a snapshot without blastRadius digests exactly the fields it always did", () => {
    const plain = snapshot();
    expect(Object.prototype.hasOwnProperty.call(plain, "blastRadius")).toBe(false);
    expect(candidateSnapshotDigest(plain)).toBe(digestOf({ schema: plain.schema, runId: plain.runId, contractDigest: plain.contractDigest, repositories: [] }));
  });

  it("the lane is bound: two candidates that differ only in lane have different digests", () => {
    const wide = snapshot({ blastRadius: { lane: "WIDE", items: [{ kind: "SCHEMA_CHANGE", repositoryRole: "primary", path: "db/1.sql" }] } });
    const irreversible = snapshot({ blastRadius: { lane: "IRREVERSIBLE", items: [{ kind: "SCHEMA_CHANGE", repositoryRole: "primary", path: "db/1.sql" }] } });
    const digests = new Set([snapshot(), wide, irreversible].map(candidateSnapshotDigest));
    expect(digests.size).toBe(3);
  });

  it("absent is CONTAINED: a stored CONTAINED lane or an empty item list is refused", () => {
    expect(candidateSnapshotSchema.safeParse({ ...snapshot(), blastRadius: { lane: "CONTAINED", items: [] } }).success).toBe(false);
    expect(candidateSnapshotSchema.safeParse({ ...snapshot(), blastRadius: { lane: "WIDE", items: [] } }).success).toBe(false);
  });
});
