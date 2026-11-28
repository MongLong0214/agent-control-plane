import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";

/**
 * The 60→59 procedure in docs/ops/owner-actions.md (#1501), its conversion extracted from the document and
 * run as written: the released v59 image, the v60 step on top of it, rows written at v60, an immutable copy,
 * and the document's SQL on that copy. The v59 image is what a P59 pair seals before the 59→60 migration,
 * and the reference the post-checks compare the converted copy with.
 *
 * Installing the copy is not rehearsed here. `record-replacement` and the rollback replay the pair's retired
 * approval up to the running build's own schema, so it is the v60 build that installs a P59 replacement, and
 * this build is not one.
 */

afterAll(cleanupTempDirs);

const OWNER_ACTIONS = readFileSync(new URL("../../docs/ops/owner-actions.md", import.meta.url), "utf8");
const block = (name: string): string => {
  const start = OWNER_ACTIONS.indexOf(`<!-- owner-actions:${name}:start -->`);
  const end = OWNER_ACTIONS.indexOf(`<!-- owner-actions:${name}:end -->`);
  if (start < 0 || end < start) throw new Error(`docs/ops/owner-actions.md carries no ${name} block`);
  return OWNER_ACTIONS.slice(OWNER_ACTIONS.indexOf("\n", start) + 1, end)
    .split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
};

const V60_TRIGGERS = ["runs_review_completion_bootstrap_only", "runs_kind_immutable"];
const sqliteCli = (args: string[], options: { cwd?: string; input?: string } = {}) =>
  spawnSync("sqlite3", args, { encoding: "utf8", timeout: 60_000, ...options });
const digestOfFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const read = <T>(path: string, query: (raw: Database.Database) => T): T => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return query(raw);
  } finally {
    raw.close();
  }
};
const schemaOf = (path: string): unknown[] =>
  read(path, (raw) => raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name").all());
const ledgerOf = (path: string): unknown[] =>
  read(path, (raw) => raw.prepare("SELECT * FROM schema_migrations ORDER BY version").all());
const withoutLedger = (tables: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(tables).filter(([table]) => table !== "schema_migrations"));

/** A database migrated from the v59 image to v60, written to at v60, and that v59 image. */
const atV60 = (): { live: string; reference: string; home: string } => {
  const home = tempDir("acp-60-59-");
  const reference = join(home, "p59", "state.sqlite");
  mkdirSync(join(home, "p59"), { mode: 0o700 });
  releasedChainImage(reference, 59);
  const live = join(home, "live", "state.sqlite");
  mkdirSync(join(home, "live"), { mode: 0o700 });
  releasedChainImage(live, 60);
  const raw = new Database(live);
  try {
    const at = new Date().toISOString();
    const audit = raw.prepare("INSERT INTO audit_events (at, kind, evidence_json) VALUES (?, ?, '{}')");
    audit.run(at, "v60-era-write");
    raw.prepare("INSERT INTO projects (project_id, name, created_at) VALUES ('p-v60', 'written at v60', ?)").run(at);
    audit.run(at, "v60-era-second-write");
  } finally {
    raw.close();
  }
  return { live, reference, home };
};

/** The procedure's copy, through an immutable open, and its conversion, as the document writes it. */
const convert = (home: string, source: string, name: string) => {
  const work = join(home, `downgrade-60-59-${name}`);
  mkdirSync(work, { mode: 0o700 });
  const copy = join(work, "state.sqlite");
  expect(sqliteCli([`file:${source}?immutable=1`, `.backup '${copy}'`]).status).toBe(0);
  chmodSync(copy, 0o600);
  writeFileSync(join(work, "convert.sql"), block("v60-to-v59-convert"), { mode: 0o600 });
  const before = digestOfFile(copy);
  const converted = sqliteCli([copy], { cwd: work, input: readFileSync(join(work, "convert.sql"), "utf8") });
  return { copy, before, converted };
};

describe("a v60 database returns to v59 on a copy (60→59)", () => {
  it("converts a v60 database written to at v60 into the P59 image's schema with every row kept", () => {
    const { live, reference, home } = atV60();
    expect(read(live, (raw) => raw.pragma("user_version", { simple: true }))).toBe(60);
    const liveDigests = contentDigests(live);
    const liveLedger = ledgerOf(live);
    const { copy, converted } = convert(home, live, "good");
    expect(converted.status, converted.stderr).toBe(0);
    expect(converted.stdout).toContain("user_version|59");

    // Post-check 1: every table but the ledger has the content it had before the transaction.
    expect(withoutLedger(contentDigests(copy).tables)).toEqual(withoutLedger(liveDigests.tables));
    // Post-check 2: the ledger lost the v60 row and nothing else.
    expect(ledgerOf(copy)).toEqual(liveLedger.filter((row) => (row as { version: number }).version !== 60));
    // Post-check 3: sqlite_schema is the v59 image's, every (type, name, tbl_name, sql) row.
    expect(schemaOf(copy)).toEqual(schemaOf(reference));
    // Post-check 4.
    read(copy, (raw) => {
      expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(raw.pragma("user_version", { simple: true })).toBe(59);
      expect(raw.prepare("SELECT kind FROM audit_events WHERE kind LIKE 'v60-era-%' ORDER BY event_id").pluck().all())
        .toEqual(["v60-era-write", "v60-era-second-write"]);
      expect(raw.prepare("SELECT name FROM projects WHERE project_id = 'p-v60'").pluck().get()).toBe("written at v60");
      expect(raw.prepare(`SELECT count(*) FROM sqlite_schema WHERE name IN (${V60_TRIGGERS.map(() => "?").join(", ")})`).pluck().get(...V60_TRIGGERS)).toBe(0);
      expect(raw.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(59);
    });
    // The source is never written.
    expect(contentDigests(live)).toEqual(liveDigests);
  }, 180_000);

  it("refuses a v61 database before it writes anything", () => {
    const home = tempDir("acp-60-59-v61-");
    const live = join(home, "live", "state.sqlite");
    mkdirSync(join(home, "live"), { mode: 0o700 });
    releasedChainImage(live, 61);
    const { copy, before, converted } = convert(home, live, "v61");
    expect(converted.status).not.toBe(0);
    expect(converted.stderr).toContain("integer overflow");
    expect(digestOfFile(copy)).toBe(before);
    expect(read(copy, (raw) => raw.pragma("user_version", { simple: true }))).toBe(61);
  }, 180_000);
});
