#!/usr/bin/env -S npx tsx
/**
 * Proves two properties of the persistence layer that no unit test asserts end to end,
 * through the project's own composition root rather than a hand-rolled SQLite call.
 *
 * WHY this check exists
 *
 *   1. `src/db/schema.sql` is applied in one `exec()` and every object is declared
 *      `IF NOT EXISTS`. That is convenient and dangerous: a duplicated declaration, a
 *      trigger whose WHEN clause can never be true, an index shadowed by another, or a
 *      CHECK no row can satisfy all fail *silently* — the file still parses, the daemon
 *      still starts, and an invariant the PRD claims is enforced simply is not. After a
 *      three-wave merge the only trustworthy statement about the schema is one made by
 *      creating a database and interrogating it.
 *
 *   2. `Db.applySchema` (src/db/database.ts) has an explicit ordered path from the pinned v11
 *      release, while a newer or pre-versioning file is refused. This script opens that genuine
 *      release schema and tampered current copies, then records what the code does with each.
 *      It also injects a failure after v12 commits and proves the original v11 image is restored.
 *
 * Everything happens in a throwaway directory under the OS temp dir; the script never
 * touches a real deployment state directory, and every probe insert is rolled back.
 *
 * Run: npx tsx scripts/verify-fresh-database.ts [--json]
 * Exits non-zero if any problem is found.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlane, defaultConfig } from "../src/app/control-plane.ts";
import { Db, SCHEMA_VERSION } from "../src/db/database.ts";
import { approveMigration } from "../src/db/migration-approval.ts";
import { isAcpError } from "../src/core/errors.ts";

const asJson = process.argv.includes("--json");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaText = readFileSync(join(repoRoot, "src/db/schema.sql"), "utf8");
const releasedSchemaText = readFileSync(join(repoRoot, "tests/fixtures/schema-v11.sql"), "utf8");

const problems: string[] = [];
const notes: string[] = [];
const observed: Record<string, unknown> = {};

/**
 * The schema and its version live in two files that different waves edit independently.
 * Recording their digests makes a run of this script reproducible evidence about a
 * specific pair of files rather than about "the repository, some time ago".
 */
observed["inputs"] = Object.fromEntries(
  ["src/db/schema.sql", "src/db/database.ts", "tests/fixtures/schema-v11.sql"].map((rel) => [
    rel,
    createHash("sha256").update(readFileSync(join(repoRoot, rel))).digest("hex").slice(0, 16),
  ]),
);

const lineOf = (index: number): number => schemaText.slice(0, index).split("\n").length;

// --------------------------------------------------------------------------
// What the file *says* it declares.
// --------------------------------------------------------------------------
interface Declaration {
  name: string;
  kind: "table" | "index" | "trigger";
  unique: boolean;
  line: number;
}

const declarations: Declaration[] = [];
for (const match of schemaText.matchAll(
  /CREATE\s+(TABLE|(UNIQUE\s+)?INDEX|TRIGGER)\s+(IF NOT EXISTS\s+)?([A-Za-z0-9_]+)/gi,
)) {
  const keyword = match[1].toUpperCase();
  declarations.push({
    name: match[4],
    kind: keyword.startsWith("TABLE") ? "table" : keyword.endsWith("INDEX") ? "index" : "trigger",
    unique: /UNIQUE/i.test(match[1]),
    line: lineOf(match.index ?? 0),
  });
}

const byName = new Map<string, Declaration[]>();
for (const declaration of declarations) {
  const list = byName.get(declaration.name) ?? [];
  list.push(declaration);
  byName.set(declaration.name, list);
}
for (const [name, list] of byName) {
  if (list.length > 1) {
    problems.push(
      `schema declares '${name}' ${list.length} times (src/db/schema.sql:${list
        .map((d) => d.line)
        .join(", :")}); the later declaration is a silent no-op under IF NOT EXISTS`,
    );
  }
}

observed["declared"] = {
  tables: declarations.filter((d) => d.kind === "table").length,
  indexes: declarations.filter((d) => d.kind === "index").length,
  triggers: declarations.filter((d) => d.kind === "trigger").length,
};

// --------------------------------------------------------------------------
// A fresh database, created the way the daemon creates one.
// --------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "acp-schema-check-"));
const config = defaultConfig(root);
let cp: ControlPlane | null = null;
let fresh: Db | null = null;
let inspection: Database.Database | null = null;

const finish = (): never => {
  try {
    cp?.close();
  } catch {
    /* closing a throwaway handle must not mask the verdict */
  }
  try {
    fresh?.close();
  } catch {
    /* same */
  }
  try {
    inspection?.close();
  } catch {
    /* same */
  }
  report();
  rmSync(root, { recursive: true, force: true });
  process.exit(problems.length === 0 ? 0 : 1);
};

try {
  cp = new ControlPlane(config);
} catch (err) {
  problems.push(`the composition root could not initialise a fresh database: ${describe(err)}`);
  finish();
}

// Db intentionally exposes only a schema-version diagnostic surface. This verifier needs
// a throwaway SQL handle for integrity, schema introspection and rollback probes, so open a
// second connection to the same temporary file and close it in finish().
const db = new Database(config.databasePath);
inspection = db;

// --- user_version ---------------------------------------------------------
const userVersion = Number(db.pragma("user_version", { simple: true }));
observed["userVersion"] = { found: userVersion, expected: SCHEMA_VERSION };
if (userVersion !== SCHEMA_VERSION) {
  problems.push(`fresh database pinned user_version=${userVersion}, expected ${SCHEMA_VERSION}`);
}

// --- integrity ------------------------------------------------------------
const integrity = db.pragma("integrity_check", { simple: true }) as string;
observed["integrityCheck"] = integrity;
if (integrity !== "ok") problems.push(`integrity_check returned '${integrity}'`);

// --- declared vs present --------------------------------------------------
const present = db
  .prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  )
  .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;

const presentNames = new Map(present.map((row) => [row.name, row]));
for (const declaration of declarations) {
  const row = presentNames.get(declaration.name);
  if (!row) {
    problems.push(
      `schema declares ${declaration.kind} '${declaration.name}' (src/db/schema.sql:${declaration.line}) ` +
        `but it is absent from a freshly initialised database`,
    );
    continue;
  }
  if (row.type !== declaration.kind) {
    problems.push(
      `'${declaration.name}' is declared as a ${declaration.kind} but exists as a ${row.type}`,
    );
  }
}
for (const row of present) {
  if (!byName.has(row.name)) {
    notes.push(`database contains ${row.type} '${row.name}' that schema.sql does not declare`);
  }
}
observed["present"] = {
  tables: present.filter((r) => r.type === "table").length,
  indexes: present.filter((r) => r.type === "index").length,
  triggers: present.filter((r) => r.type === "trigger").length,
};

// --- generated columns ----------------------------------------------------
const tables = present.filter((r) => r.type === "table").map((r) => r.name);
const generatedColumns: string[] = [];
for (const table of tables) {
  for (const column of db.pragma(`table_xinfo(${quoteIdent(table)})`) as Array<{
    name: string;
    hidden: number;
  }>) {
    // 2 = VIRTUAL generated, 3 = STORED generated.
    if (column.hidden === 2 || column.hidden === 3) generatedColumns.push(`${table}.${column.name}`);
  }
}
observed["generatedColumns"] = generatedColumns;

// --- shadowed / redundant indexes ----------------------------------------
interface IndexShape {
  name: string;
  table: string;
  unique: boolean;
  partial: boolean;
  columns: string;
}
const indexShapes: IndexShape[] = [];
for (const row of present.filter((r) => r.type === "index")) {
  const info = db.pragma(`index_xinfo(${quoteIdent(row.name)})`) as Array<{
    key: number;
    name: string | null;
  }>;
  const columns = info
    .filter((entry) => entry.key === 1)
    .map((entry) => entry.name ?? "<rowid>")
    .join(",");
  const list = db.pragma(`index_list(${quoteIdent(row.tbl_name)})`) as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const meta = list.find((entry) => entry.name === row.name);
  indexShapes.push({
    name: row.name,
    table: row.tbl_name,
    unique: Boolean(meta?.unique),
    partial: Boolean(meta?.partial),
    columns,
  });
}

for (const left of indexShapes) {
  for (const right of indexShapes) {
    if (left.name >= right.name || left.table !== right.table) continue;
    if (left.columns !== right.columns) continue;
    if (left.partial !== right.partial) continue;
    problems.push(
      `indexes '${left.name}' and '${right.name}' cover the same columns (${left.table}: ${left.columns}); ` +
        `one shadows the other`,
    );
  }
}
for (const nonUnique of indexShapes.filter((i) => !i.unique && !i.partial)) {
  const covering = indexShapes.find(
    (other) =>
      other.name !== nonUnique.name &&
      other.table === nonUnique.table &&
      !other.partial &&
      other.columns.startsWith(nonUnique.columns),
  );
  if (covering) {
    notes.push(
      `index '${nonUnique.name}' (${nonUnique.table}: ${nonUnique.columns}) is a prefix of ` +
        `'${covering.name}' (${covering.columns}) and adds no lookup path`,
    );
  }
}

// --- triggers whose denial can be pre-empted -----------------------------
interface TriggerShape {
  name: string;
  table: string;
  event: string;
  conditional: boolean;
  raises: string[];
}
const triggerShapes: TriggerShape[] = present
  .filter((r) => r.type === "trigger")
  .map((row) => {
    const sql = row.sql ?? "";
    const event = /BEFORE\s+(INSERT|UPDATE|DELETE)/i.exec(sql)?.[1]?.toUpperCase() ?? "?";
    return {
      name: row.name,
      table: row.tbl_name,
      event,
      conditional: /\bWHEN\b/i.test(sql),
      raises: [...sql.matchAll(/RAISE\(ABORT,\s*'([A-Z0-9_]+)'\)/g)].map((m) => m[1]),
    };
  });

for (const unconditional of triggerShapes.filter((t) => !t.conditional)) {
  for (const other of triggerShapes) {
    if (other.name === unconditional.name) continue;
    if (other.table !== unconditional.table || other.event !== unconditional.event) continue;
    problems.push(
      `trigger '${unconditional.name}' aborts every ${unconditional.event} on ${unconditional.table}, ` +
        `so '${other.name}' can never report its own reason`,
    );
  }
}
const conditionalPairs = new Map<string, string[]>();
for (const trigger of triggerShapes.filter((t) => t.conditional)) {
  const key = `${trigger.table}:${trigger.event}`;
  conditionalPairs.set(key, [...(conditionalPairs.get(key) ?? []), trigger.name]);
}
for (const [key, names] of conditionalPairs) {
  if (names.length > 1) {
    notes.push(
      `${names.length} conditional triggers guard ${key} (${names.join(", ")}); when more than one ` +
        `WHEN clause matches, which reason the caller sees depends on SQLite's trigger order`,
    );
  }
}
observed["triggers"] = triggerShapes;

// --- foreign keys actually resolve ---------------------------------------
const fkProblems: string[] = [];
for (const table of tables) {
  const keys = db.pragma(`foreign_key_list(${quoteIdent(table)})`) as unknown[];
  if ((keys as unknown[]).length === 0) continue;
  try {
    db.pragma(`foreign_key_check(${quoteIdent(table)})`);
  } catch (err) {
    fkProblems.push(`${table}: ${describe(err)}`);
  }
}
for (const entry of fkProblems) {
  problems.push(`foreign key does not resolve against a unique parent key — ${entry}`);
}

// --------------------------------------------------------------------------
// Can each table hold a row at all? A CHECK that contradicts another CHECK, or
// contradicts the column's own DEFAULT, makes a table permanently unwritable while
// still parsing cleanly. Every attempt below is rolled back.
// --------------------------------------------------------------------------
const MAX_COMBINATIONS = 4096;
const satisfiability: Array<{ table: string; verdict: string; detail?: string }> = [];

db.pragma("foreign_keys = OFF");
for (const table of tables) {
  const columns = (
    db.pragma(`table_xinfo(${quoteIdent(table)})`) as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>
  ).filter((column) => column.hidden === 0);

  const sql = presentNames.get(table)?.sql ?? "";
  const enums = new Map<string, string[]>();
  for (const match of sql.matchAll(/\b([A-Za-z0-9_]+)\s+IN\s*\(([^()]*)\)/g)) {
    enums.set(
      match[1],
      match[2].split(",").map((value) => value.trim()),
    );
  }
  // A `LIKE 'sha256:%'` CHECK rejects an arbitrary probe string, which would look like an
  // unsatisfiable table. Derive a value from the pattern instead of guessing.
  const patterns = new Map<string, string>();
  for (const match of sql.matchAll(/\b([A-Za-z0-9_]+)\s+LIKE\s+'([^']*)'/g)) {
    patterns.set(match[1], `'${match[2].replace(/%/g, "probe").replace(/_/g, "x")}'`);
  }

  const typedValue = (column: { name: string; type: string }): string => {
    if (patterns.has(column.name)) return patterns.get(column.name)!;
    const type = column.type.toUpperCase();
    if (type.startsWith("INT")) return "1";
    if (type.startsWith("REAL") || type.startsWith("NUM")) return "0";
    return `'probe_${table}_${column.name}'`;
  };

  const candidates = columns.map((column) => {
    const enumeration = enums.get(column.name);
    if (enumeration && enumeration.length > 0) {
      const preferred = column.dflt_value && enumeration.includes(column.dflt_value.trim());
      return preferred
        ? [column.dflt_value!.trim(), ...enumeration.filter((v) => v !== column.dflt_value!.trim())]
        : enumeration;
    }
    if (column.dflt_value !== null) return [column.dflt_value];
    if (column.notnull === 1 || column.pk === 1) return [typedValue(column)];
    // A nullable column may still be required by a table-level CHECK ("at least one of
    // branch, worktree_id, declared_path"), so NULL alone is not a fair probe.
    return ["NULL", typedValue(column)];
  });

  let inserted = false;
  let attempts = 0;
  const failures = new Set<string>();
  let lastError = "";

  const total = candidates.reduce((product, values) => product * values.length, 1);
  const limit = Math.min(total, MAX_COMBINATIONS);
  for (let index = 0; index < limit; index += 1) {
    let remainder = index;
    const values = candidates.map((options) => {
      const value = options[remainder % options.length];
      remainder = Math.floor(remainder / options.length);
      return value;
    });
    attempts += 1;
    db.exec("SAVEPOINT probe");
    try {
      db.exec(
        `INSERT INTO ${quoteIdent(table)} (${columns
          .map((c) => quoteIdent(c.name))
          .join(", ")}) VALUES (${values.join(", ")})`,
      );
      inserted = true;
    } catch (err) {
      lastError = describe(err);
      failures.add(classify(lastError));
    } finally {
      db.exec("ROLLBACK TO probe");
      db.exec("RELEASE probe");
    }
    if (inserted) break;
  }

  const seeded =
    (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n > 0;

  if (inserted) {
    satisfiability.push({ table, verdict: "satisfiable", detail: `after ${attempts} attempt(s)` });
  } else if (seeded && !failures.has("check")) {
    // A single-row table the schema seeds itself (continuity_state) rejects a probe on
    // uniqueness, which proves the row shape is fine rather than the opposite.
    satisfiability.push({ table, verdict: "satisfiable", detail: "seeded row already present" });
  } else if (failures.size === 1 && failures.has("check")) {
    problems.push(
      `table '${table}' rejected all ${attempts} candidate rows on CHECK constraints alone; ` +
        `no row can satisfy its declared CHECKs (last error: ${lastError})`,
    );
    satisfiability.push({ table, verdict: "unsatisfiable-checks", detail: lastError });
  } else {
    satisfiability.push({
      table,
      verdict: "inconclusive",
      detail: `${[...failures].join("+")} — ${lastError}`,
    });
    notes.push(
      `table '${table}': no probe row was accepted, and the blocker was ${[...failures].join("+")} ` +
        `rather than a CHECK alone, so satisfiability is undecided here (${lastError})`,
    );
  }
}
db.pragma("foreign_keys = ON");
observed["satisfiability"] = satisfiability;
db.close();
inspection = null;

// --------------------------------------------------------------------------
// Re-opening the *same* version must stay clean, the pinned released v11 shape must migrate,
// a failed migration must restore that exact older shape, and newer or pre-versioning versions
// must be refused. This is check 2: the version contract is deliberately asymmetric.
// --------------------------------------------------------------------------
cp!.close();
cp = null;

const reopen = attempt(() => {
  const handle = new Db(config.databasePath);
  handle.close();
});
observed["reopenSameVersion"] = reopen;
if (!reopen.ok) {
  problems.push(`re-opening a database at the current version failed: ${reopen.message}`);
}

const tamper = (label: string, mutate: (raw: Database.Database) => void) => {
  const path = join(root, `${label}.sqlite`);
  copyFileSync(config.databasePath, path);
  const raw = new Database(path);
  mutate(raw);
  raw.close();
  const outcome = attempt(() => {
    const handle = new Db(path);
    handle.close();
  });
  observed[label] = outcome;
  return outcome;
};

const createPinnedV11 = (path: string, mutate?: (raw: Database.Database) => void): void => {
  const raw = new Database(path);
  try {
    raw.exec(releasedSchemaText);
    mutate?.(raw);
    raw.pragma("user_version = 11");
  } finally {
    raw.close();
  }
  chmodSync(path, 0o600);
  // #738 — a database at an older version no longer migrates itself. The verifier is asking
  // what an approved upgrade does, so it takes the approval the owner would take.
  approveMigration(path, "verify-fresh-database");
};

const olderPath = join(root, "olderVersion.sqlite");
createPinnedV11(olderPath);
const older = attempt(() => {
  const handle = new Db(olderPath);
  handle.close();
});
observed["olderVersion"] = older;

const migrationRestorePath = join(root, "migrationRestore.sqlite");
createPinnedV11(migrationRestorePath, (raw) => {
  // v12 genuinely repairs this released-schema guard. The injected failure happens after that
  // commit, so rollback has to accept and restore the pre-migration image that still lacks it.
  raw.exec("DROP TRIGGER github_receipts_no_delete");
});
const migrationRestore = attempt(() => {
  let injectedFailure: unknown;
  try {
    const handle = new Db(migrationRestorePath, {
      afterMigration: (migration) => {
        if (migration.toVersion === 12) {
          throw new Error("injected failure after v12 committed its invariant replay");
        }
      },
    });
    handle.close();
  } catch (error) {
    injectedFailure = error;
  }
  if (
    !isAcpError(injectedFailure) ||
    injectedFailure.message !==
      "migration failed; the original database was restored from its automatic backup"
  ) {
    throw injectedFailure ?? new Error("the injected migration failure did not stop the upgrade");
  }

  const restored = new Database(migrationRestorePath, { readonly: true, fileMustExist: true });
  try {
    const restoredVersion = Number(restored.pragma("user_version", { simple: true }));
    const restoredMissingGuard = restored
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'github_receipts_no_delete'",
      )
      .get() as { n: number };
    if (restoredVersion !== 11 || restoredMissingGuard.n !== 0) {
      throw new Error(
        `automatic rollback did not restore the original v11 shape ` +
          `(user_version=${restoredVersion}, missing_guard=${restoredMissingGuard.n === 0})`,
      );
    }
  } finally {
    restored.close();
  }
});
observed["migrationRestore"] = migrationRestore;

const newer = tamper("newerVersion", (raw) => raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`));
const preVersioning = tamper("preVersioningVersion", (raw) => raw.pragma("user_version = 0"));

if (!older.ok) {
  problems.push(`the pinned v11 schema failed to migrate: ${older.message}`);
}
if (!migrationRestore.ok) {
  problems.push(`a failed migration did not restore the original pinned v11 image: ${migrationRestore.message}`);
}
for (const [label, outcome] of [
  ["newer", newer],
  ["pre-versioning", preVersioning],
] as const) {
  if (outcome.ok) {
    problems.push(`${label} database was opened instead of being refused`);
  }
}

for (const [label, outcome] of [
  ["newer", newer],
  ["pre-versioning", preVersioning],
] as const) {
  if (!outcome.ok && !outcome.reasonCode) {
    problems.push(
      `${label} database was refused with a plain Error carrying no reason code, so callers cannot ` +
        `match on the denial (message: ${outcome.message})`,
    );
  }
}

finish();

// --------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classify(message: string): string {
  if (message.includes("CHECK constraint failed")) return "check";
  if (message.includes("NOT NULL constraint failed")) return "notnull";
  if (message.includes("UNIQUE constraint failed") || message.includes("PRIMARY KEY")) return "unique";
  if (message.includes("FOREIGN KEY")) return "foreignkey";
  if (/[A-Z_]{6,}/.test(message)) return "trigger";
  return "other";
}

function attempt(action: () => void): {
  ok: boolean;
  reasonCode?: string;
  message?: string;
  evidence?: unknown;
} {
  try {
    action();
    return { ok: true };
  } catch (err) {
    if (isAcpError(err)) {
      return { ok: false, reasonCode: err.reasonCode, message: err.message, evidence: err.evidence };
    }
    return { ok: false, message: describe(err) };
  }
}

function report(): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ observed, problems, notes }, null, 2)}\n`);
    return;
  }
  console.log(`inputs (sha256/16)   : ${JSON.stringify(observed["inputs"])}`);
  console.log(`schema.sql declares  : ${JSON.stringify(observed["declared"])}`);
  console.log(`fresh database has   : ${JSON.stringify(observed["present"])}`);
  console.log(`user_version         : ${JSON.stringify(observed["userVersion"])}`);
  console.log(`integrity_check      : ${observed["integrityCheck"]}`);
  console.log(`generated columns    : ${JSON.stringify(observed["generatedColumns"])}`);
  console.log("");
  console.log("row satisfiability:");
  for (const entry of satisfiability) {
    console.log(`  ${entry.verdict.padEnd(22)} ${entry.table}  ${entry.detail ?? ""}`);
  }
  console.log("");
  console.log("version handling:");
  for (const key of [
    "reopenSameVersion",
    "olderVersion",
    "migrationRestore",
    "newerVersion",
    "preVersioningVersion",
  ]) {
    console.log(`  ${key.padEnd(22)} ${JSON.stringify(observed[key])}`);
  }
  console.log("");
  for (const note of notes) console.log(`note: ${note}`);
  console.log("");
  if (problems.length === 0) {
    console.log(
      "OK — fresh database applies cleanly, pinned v11 migrates, its injected post-v12 failure restores v11, and newer/pre-versioning schemas are refused",
    );
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}
