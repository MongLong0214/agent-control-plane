import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Every trigger in schema.sql must have a runtime existence check.
 *
 * A rule-inventory sweep found that 20 of 29 triggers had none. That gap is invisible by
 * construction: nearly every test enters through the application path, which refuses bad writes
 * long before the database layer is reached, so deleting a trigger during a migration rewrite
 * fails nothing at all. The loss surfaces only when someone attempts the raw-SQL bypass the
 * trigger exists to refuse — which is to say, when it is already too late.
 *
 * These reconcile the two lists mechanically rather than by review, because the original list
 * was assembled by hand and drifted for exactly as long as nothing compared it to the schema.
 */
const schema = readFileSync(
  fileURLToPath(new URL("../../src/db/schema.sql", import.meta.url)),
  "utf8",
);

const triggersInSchema = [...schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)/g)].map(
  (m) => m[1]!,
);

const freshDatabasePath = (): string => join(tempDir("schema-triggers"), "acp.db");

describe("every schema trigger is load-bearing and checked", () => {
  it("declares at least the triggers this repository ships", () => {
    expect(triggersInSchema.length).toBeGreaterThanOrEqual(29);
  });

  it("creates every trigger schema.sql declares", () => {
    const path = freshDatabasePath();
    const db = new Db(path);
    db.close();

    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const live = new Set(
        (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      const absent = triggersInSchema.filter((t) => !live.has(t));
      expect(absent, `declared in schema.sql but never created: ${absent.join(", ")}`).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("carries every schema.sql trigger in the required list", () => {
    // The reconciliation this file exists for. Without it the required list is only checked
    // against itself: a new trigger added by a migration would be created, annotated, and
    // still absent from the list that makes its disappearance an error.
    const migrations = readFileSync(
      fileURLToPath(new URL("../../src/db/migrations.ts", import.meta.url)),
      "utf8",
    );
    // Parse the arrays, not the file. A bare /name: "(\w+)"/ sweep over migrations.ts counts
    // any such string anywhere — including one left behind in a comment or an unrelated
    // literal — so a trigger could be dropped from every required list and still look listed.
    const arrays = [...migrations.matchAll(/REQUIRED_\w*TRIGGERS[^=]*=\s*\[([\s\S]*?)\n\];/g)];
    expect(arrays.length, "no REQUIRED_*TRIGGERS arrays found in migrations.ts").toBeGreaterThan(0);
    const required = new Set(
      arrays.flatMap((a) => [...a[1]!.matchAll(/\bname:\s*"(\w+)"/g)].map((m) => m[1]!)),
    );
    const unlisted = triggersInSchema.filter((t) => !required.has(t));
    expect(
      unlisted,
      `declared in schema.sql but absent from the required-trigger lists: ${unlisted.join(", ")}`,
    ).toEqual([]);
  });

  it("refuses to open a database whose load-bearing trigger was dropped", () => {
    // The property under test is that the *check* fires, so this drops one of the twenty that
    // had no existence check. Before REQUIRED_SCHEMA_TRIGGERS, reopening this succeeded.
    const path = freshDatabasePath();
    const db = new Db(path);
    db.close();

    const raw = new Database(path);
    raw.exec("DROP TRIGGER audit_events_append_only");
    raw.close();

    expect(() => new Db(path)).toThrowError(/load-bearing schema invariant/);
  });

  it("names the hard invariant each trigger backs, in the same file as the trigger", () => {
    // Prose that lives elsewhere drifts: this repository's README described a closed issue as an
    // open blocker for a day. Adjacent prose is checked here so it cannot rot unnoticed.
    const lines = schema.split("\n");
    const undocumented: string[] = [];
    lines.forEach((line, index) => {
      if (!line.startsWith("CREATE TRIGGER IF NOT EXISTS ")) return;
      const name = line.split(" ").at(-1)!;
      let cursor = index - 1;
      const block: string[] = [];
      while (cursor >= 0 && lines[cursor]!.trim().startsWith("--")) {
        block.unshift(lines[cursor]!);
        cursor -= 1;
      }
      if (!/CP-HI-0[1-8]/.test(block.join(" "))) undocumented.push(name);
    });
    expect(
      undocumented,
      `triggers with no CP-HI reference directly above them: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });
});
