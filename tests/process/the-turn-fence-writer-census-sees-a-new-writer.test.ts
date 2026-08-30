import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #676: residual zero for the turn-fence ledger was demonstrated once, off-repo, by a script that
 * ran nowhere afterward. Nothing here checked whether a second file had started writing
 * `canonical_turns` or its satellites, and the schema's own triggers do not fill that gap — they
 * refuse a *bad* write regardless of who sends it, but a file that reconstructs the coordinator's
 * own INSERT/UPDATE shape satisfies every one of them while going around the coordinator itself.
 *
 * So the census (`scripts/verify-turn-fence-writer-census.mjs`) is run against a clone carrying a
 * synthetic second writer, and required to fail — then run again with the writer removed, and
 * required to pass. A check that has never failed is not known to work.
 *
 * A blind adversarial review of the first version found its detector recognised exactly one
 * spelling of each write statement — plain uppercase `INSERT INTO`/`UPDATE`/`DELETE FROM` followed
 * by a bare identifier — and missed `INSERT OR ABORT`, `INSERT OR IGNORE`, a quoted table name, a
 * schema-qualified one, and lowercase SQL outright, plus `REPLACE INTO` by name. A synthetic
 * violation written in only the one form the regex recognised proved the check catches that form,
 * not that it catches the defect. So every write form the review named is probed here, in both
 * directions — MISSED before the fix, caught after — rather than the one shape the first version
 * happened to get right.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-turn-fence-writer-census.mjs";

/** A throwaway clone carrying the working-tree census and source tree, so this measures the script being edited. */
const scratchRepo = (): string => {
  const dir = join(tempDir("acp-writer-census-"), "repo");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--depth", "1", ROOT, dir]);
  // Copy the working-tree script and source over the clone's committed versions, the same way
  // the sibling census test does, so a not-yet-committed edit to either is what gets measured.
  execFileSync("cp", [join(ROOT, SCRIPT), join(dir, SCRIPT)]);
  rmSync(join(dir, "src"), { recursive: true, force: true });
  execFileSync("cp", ["-R", join(ROOT, "src"), join(dir, "src")]);
  return dir;
};

const censusOn = (dir: string): { status: number | null; stdout: string } => {
  const done = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout };
};

const writeProbe = (repo: string, name: string, body: string): void => {
  mkdirSync(join(repo, "src/probe"), { recursive: true });
  writeFileSync(
    join(repo, "src/probe", name),
    [
      `// Synthetic writer-form probe for issue #676, round 2.`,
      'import type { Db } from "../db/database.ts";',
      "",
      "export const rogueWrite = (db: Db, turnRequestId: string): void => {",
      `  ${body}`,
      "};",
      "",
    ].join("\n"),
  );
};

describe("the turn-fence writer census sees a writer outside the coordinator", () => {
  it("fails when a new file writes canonical_turns directly", () => {
    const repo = scratchRepo();
    writeProbe(
      repo,
      "rogue-writer-676.ts",
      "db.run(`UPDATE canonical_turns SET lifecycle_state = 'SETTLED' WHERE turn_request_id = ?`, [turnRequestId]);",
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-writer-676.ts");
    expect(done.stdout).toContain("canonical_turns");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("fails when a new file writes actor_target_attestations, which nothing has ever written", () => {
    // The one table with a declared owner list of zero. Any writer at all is new.
    const repo = scratchRepo();
    writeProbe(
      repo,
      "rogue-attester-676.ts",
      'db.run(`INSERT INTO actor_target_attestations (target_attestation_id) VALUES (?)`, ["x"]);',
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("actor_target_attestations");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("passes on the source tree as it stands, so the two failures above are about the probe", () => {
    const repo = scratchRepo();

    const done = censusOn(repo);

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.stdout).toContain("residual: 0");
    expect(done.status).toBe(0);
  });

  it("fails when a declared owner no longer writes its table", () => {
    // The other direction of the same defect: an exemption nothing consults. Rather than edit the
    // source tree, this rewrites the census's own OWNERS entry to name a file that writes
    // nothing, which is what a stale owner looks like after a real writer is deleted or renamed.
    const repo = scratchRepo();
    execFileSync("node", [
      "-e",
      `const fs=require('fs');const p='${SCRIPT}';let s=fs.readFileSync(p,'utf8');` +
        `s=s.replace('actor_target_bindings: ["src/session/binding-registry.ts"],', ` +
        `'actor_target_bindings: ["src/session/a-file-that-does-not-write-this-anymore.ts"],');` +
        `fs.writeFileSync(p,s);`,
    ], { cwd: repo });

    const done = censusOn(repo);

    expect(done.stdout).toContain("actor_target_bindings");
    expect(done.stdout).toContain("no longer writes its table");
    expect(done.status).toBe(1);
  });

  /**
   * Every write form the blind review fed the old regex and got MISSED back, plus the ones it
   * named as untested (REPLACE INTO, UPDATE's own OR clause, backtick/bracket quoting, multi-line).
   * One probe file per form, one governed table (`canonical_turns`) per probe, so a regression in
   * any single alternative reads as a specific missing FAIL rather than a generic count change.
   */
  const forms: Array<{ label: string; body: string }> = [
    { label: "INSERT OR ABORT", body: "db.run(`INSERT OR ABORT INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "INSERT OR IGNORE", body: "db.run(`INSERT OR IGNORE INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "INSERT OR ROLLBACK", body: "db.run(`INSERT OR ROLLBACK INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "INSERT OR FAIL", body: "db.run(`INSERT OR FAIL INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "INSERT OR REPLACE", body: "db.run(`INSERT OR REPLACE INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "bare REPLACE INTO", body: "db.run(`REPLACE INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "UPDATE OR ABORT", body: "db.run(`UPDATE OR ABORT canonical_turns SET lifecycle_state = 'SETTLED' WHERE turn_request_id = ?`, [turnRequestId]);" },
    { label: "double-quoted table", body: 'db.run(`UPDATE "canonical_turns" SET lifecycle_state = \'SETTLED\' WHERE turn_request_id = ?`, [turnRequestId]);' },
    // A double-quoted outer string, not a backtick template literal, so the backtick around the
    // table name is a bare source character and this actually exercises backtick-quote detection
    // rather than an escaped-backtick artifact of nesting one template literal inside another.
    { label: "backtick-quoted table", body: 'db.run("UPDATE `canonical_turns` SET lifecycle_state = \'SETTLED\' WHERE turn_request_id = ?", [turnRequestId]);' },
    { label: "bracket-quoted table", body: "db.run(`UPDATE [canonical_turns] SET lifecycle_state = 'SETTLED' WHERE turn_request_id = ?`, [turnRequestId]);" },
    { label: "schema-qualified table", body: "db.run(`DELETE FROM main.canonical_turns WHERE turn_request_id = ?`, [turnRequestId]);" },
    { label: "lowercase sql", body: "db.run(`update canonical_turns set lifecycle_state = 'SETTLED' where turn_request_id = ?`, [turnRequestId]);" },
    { label: "mixed case sql", body: "db.run(`Update canonical_turns Set lifecycle_state = 'SETTLED' where turn_request_id = ?`, [turnRequestId]);" },
    {
      label: "multi-line statement",
      body: [
        "db.run(",
        "    `UPDATE canonical_turns",
        "     SET lifecycle_state = 'SETTLED'",
        "     WHERE turn_request_id = ?`,",
        "    [turnRequestId],",
        "  );",
      ].join("\n  "),
    },
    // Round 3 of #676: a blind review ran these three directly against system SQLite and confirmed
    // they execute as ordinary writes — the old pattern required literal `\s+` at every keyword
    // boundary, and a `/**/` comment there is whitespace to SQLite but not to that regex, so all
    // three scored `residual: 0`. Interleaved at every keyword boundary the review didn't name too,
    // both to close the exact spellings and the shape one level up.
    { label: "INSERT/**/INTO block comment", body: "db.run(`INSERT/**/INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "INSERT INTO/**/table block comment", body: "db.run(`INSERT INTO/**/canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "UPDATE/**/table block comment", body: "db.run(`UPDATE/**/canonical_turns SET lifecycle_state = 'SETTLED' WHERE turn_request_id = ?`, [turnRequestId]);" },
    { label: "DELETE/**/FROM block comment", body: "db.run(`DELETE/**/FROM canonical_turns WHERE turn_request_id = ?`, [turnRequestId]);" },
    { label: "DELETE FROM/**/table block comment", body: "db.run(`DELETE FROM/**/canonical_turns WHERE turn_request_id = ?`, [turnRequestId]);" },
    { label: "REPLACE/**/INTO block comment", body: "db.run(`REPLACE/**/INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "REPLACE INTO/**/table block comment", body: "db.run(`REPLACE INTO/**/canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "INSERT OR/**/IGNORE block comment", body: "db.run(`INSERT OR/**/IGNORE INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    { label: "INSERT OR IGNORE/**/INTO block comment", body: "db.run(`INSERT OR IGNORE/**/INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);" },
    {
      label: "UPDATE--line comment before table",
      body: "db.run(`UPDATE--x\ncanonical_turns SET lifecycle_state = 'SETTLED' WHERE turn_request_id = ?`, [turnRequestId]);",
    },
    {
      label: "INSERT--line comment before INTO",
      body: "db.run(`INSERT--x\nINTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);",
    },
  ];

  for (const { label, body } of forms) {
    it(`fails on a ${label} write to canonical_turns`, () => {
      const repo = scratchRepo();
      const filename = `rogue-form-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.ts`;
      writeProbe(repo, filename, body);

      const done = censusOn(repo);

      expect(done.stdout).toContain(`src/probe/${filename}`);
      expect(done.stdout).toContain("RESULT: FAIL");
      expect(done.status).toBe(1);
    });
  }

  it("reports a dynamically built table name as unresolved rather than silently scoring it zero", () => {
    // No static regex can name a table built at runtime. The honest response is a loud, distinct
    // failure — not a PASS that looks identical to a real all-clear.
    const repo = scratchRepo();
    writeProbe(
      repo,
      "rogue-dynamic-table.ts",
      'const table = "canonical_turns"; db.run(`INSERT INTO ${table} (turn_request_id) VALUES (?)`, [turnRequestId]);',
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-dynamic-table.ts");
    expect(done.stdout).toContain("not a static table name this census can read");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.stdout).toContain("could not resolve");
    expect(done.status).toBe(1);
  });

  it("fails when src/db/migrations.ts writes a governed table directly, not just src/**", () => {
    // Finding 2 of the same review: migrations.ts was excluded on the claim that `schema:registry`
    // and `schema:denials` already score its data-moving statements. Neither actually reads a line
    // of migrations.ts — one confirms every declared trigger is in a required-trigger registry, the
    // other confirms every trigger sentinel maps to a typed ReasonCode. So this appends a real
    // write to the actual file the exclusion used to name, rather than a probe file, and requires
    // the census to see it now that the exclusion is gone.
    const repo = scratchRepo();
    appendFileSync(
      join(repo, "src/db/migrations.ts"),
      [
        "",
        "// Synthetic probe for issue #676, round 2: migrations.ts is no longer exempt.",
        "export const __rogueMigrationWrite676 = (db: import(\"./database.ts\").Db, turnRequestId: string): void => {",
        "  db.run(`INSERT OR IGNORE INTO canonical_turns (turn_request_id) VALUES (?)`, [turnRequestId]);",
        "};",
        "",
      ].join("\n"),
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("src/db/migrations.ts");
    expect(done.stdout).toContain("canonical_turns");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("does not fabricate a write from migrations.ts's own doc comments quoting old, defective SQL", () => {
    // The reason migrations.ts used to be excluded wholesale: its comments document this ledger's
    // past defects by quoting the broken SQL verbatim, e.g. a plain `UPDATE canonical_turns SET
    // outcome_kind='ABORTED'`. Included-but-comment-blind would fail on prose, not code. Confirmed
    // by the unmodified real source tree passing (the earlier "passes on the source tree as it
    // stands" test already covers this on real migrations.ts) and, here, an added comment-only
    // quotation is still silent.
    const repo = scratchRepo();
    appendFileSync(
      join(repo, "src/db/migrations.ts"),
      [
        "",
        "// A synthetic doc comment, same shape as the real one: `UPDATE canonical_turns SET",
        "// outcome_kind='ABORTED'` describes a defect this schema no longer permits.",
        "",
      ].join("\n"),
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.stdout).toContain("residual: 0");
    expect(done.status).toBe(0);
  });

  it("fails when a schema.sql trigger body writes a governed table directly, not just src/**.ts", () => {
    // Finding 2, round 3: `migrations.ts`'s `schemaDdl()` reads `src/db/schema.sql` whole and
    // installs it into the real database, so a trigger body in that file is exactly as live a
    // write surface as a TypeScript module — and the walk above only ever reads `.ts` files.
    // `schema.sql` was read for `CREATE TABLE` names only; a second writer sitting in a trigger
    // body forever would never have been seen. This appends a real cascading write, the same shape
    // a materializer-adjacent trigger could plausibly carry, and requires the census to see it.
    const repo = scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      [
        "",
        "CREATE TRIGGER IF NOT EXISTS probe_676_rogue_cascade",
        "AFTER INSERT ON canonical_turn_dispatches",
        "BEGIN",
        "  INSERT INTO canonical_turn_sources (turn_request_id) VALUES (NEW.turn_request_id);",
        "END;",
        "",
      ].join("\n"),
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("src/db/schema.sql");
    expect(done.stdout).toContain("canonical_turn_sources");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.status).toBe(1);
  });

  it("does not fabricate a write from schema.sql's own trigger doc comments quoting old, defective SQL", () => {
    // schema.sql already carries this exact shape for real, above `canonical_turns_settlement_authority`:
    // "...an ordinary `UPDATE canonical_turns SET lifecycle_state='SETTLED', outcome_kind='ABORTED', …`
    // on a turn that had never been settled succeeded...". Scanning schema.sql without stripping its
    // own `--`/`/* */` comments first would fail on that prose the moment schema.sql joined the scan.
    // Confirmed by the unmodified real source tree passing (the earlier "passes on the source tree as
    // it stands" test already covers this on the real file) and, here, an added comment-only
    // quotation appended fresh is still silent.
    const repo = scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      [
        "",
        "-- A synthetic doc comment, same shape as the real one: an ordinary",
        "-- `UPDATE canonical_turns SET outcome_kind='ABORTED'` describes a defect this schema no",
        "-- longer permits.",
        "",
      ].join("\n"),
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.stdout).toContain("residual: 0");
    expect(done.status).toBe(0);
  });

  /**
   * Round 4 of #676: a blind review found the "unresolvable" path itself defeatable. `IDENT`'s bare
   * alternative (`[A-Za-z_]\w*`) cannot include `$`, so a table name with a *static prefix* followed
   * by a template placeholder — `canonical_turn_${suffix}` — does not fail to match the way a name
   * with no static part at all does (`${table}`, already covered above). It matches the prefix alone,
   * which does not equal any governed table's name, so the write used to vanish as a silently
   * unresolved-but-not-reported reference. With `suffix === "s"` in production this is a live write to
   * `canonical_turns`. A truncated prefix must land in the same loud `unresolvable` path as a name
   * with no static part, not resolve to whatever it happens to share letters with.
   */
  it("treats a table name truncated by a template placeholder as unresolved, not a coincidentally similar table", () => {
    const repo = scratchRepo();
    writeProbe(
      repo,
      "rogue-truncated-template-676.ts",
      'const suffix = "s"; db.run(`UPDATE canonical_turn_${suffix} SET lifecycle_state = ?`, [turnRequestId]);',
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("src/probe/rogue-truncated-template-676.ts");
    expect(done.stdout).toContain("not a static table name this census can read");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.stdout).toContain("could not resolve");
    expect(done.status).toBe(1);
  });

  /**
   * Round 4, finding 2: `CREATE_TABLE`'s old pattern required literal `\s+` at every keyword
   * boundary and a bare identifier with no schema qualifier — so a table declared as
   * `CREATE/**\/TABLE foo (` (a comment is whitespace to SQLite at any boundary, confirmed against
   * system SQLite the same way the writer-side `WS` fix was) or `CREATE TABLE main.foo (`
   * (schema-qualified, which the writer side already tolerates via `TABLE_REF`) entered nothing:
   * not `governedTables`, not `OWNERS`, not the writer scan. Both forms are probed here — the new
   * table must at least be *seen* (and, having no `OWNERS` entry, must fail as unowned) rather than
   * silently absent from an 8-table PASS.
   */
  it("discovers a governed table declared with an SQL comment between CREATE and TABLE", () => {
    const repo = scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      "\nCREATE/**/TABLE IF NOT EXISTS canonical_turn_probe_676a (\n  turn_request_id TEXT PRIMARY KEY\n);\n",
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("canonical_turn_probe_676a");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.stdout).toContain("no owner entry");
    expect(done.status).toBe(1);
  });

  it("discovers a governed table declared with a schema-qualified name", () => {
    const repo = scratchRepo();
    appendFileSync(
      join(repo, "src/db/schema.sql"),
      "\nCREATE TABLE main.canonical_turn_probe_676b (\n  turn_request_id TEXT PRIMARY KEY\n);\n",
    );

    const done = censusOn(repo);

    expect(done.stdout).toContain("canonical_turn_probe_676b");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.stdout).toContain("no owner entry");
    expect(done.status).toBe(1);
  });

  /**
   * Round 4, finding 3: the `staleOwners` loop only ever visits tables still in `governedTables`, so
   * it can only notice an owner that stopped writing a table the schema *still declares*. An `OWNERS`
   * key for a table the schema no longer declares at all was never visited by anything — it would sit
   * unexamined until someone happened to delete it by hand, and if the same table name were ever
   * reintroduced, that stale key would stand in as if a fresh review had already covered it. This
   * removes the `CREATE TABLE` backing the one owner entry that is easiest to isolate
   * (`actor_target_attestations`, already declared with zero writers) without touching `OWNERS`, so
   * the only change is that the schema stops declaring the table the entry names.
   */
  it("fails when OWNERS names a table the schema no longer declares", () => {
    const repo = scratchRepo();
    execFileSync("node", [
      "-e",
      `const fs=require('fs');const p='src/db/schema.sql';let s=fs.readFileSync(p,'utf8');` +
        `s=s.replace('CREATE TABLE IF NOT EXISTS actor_target_attestations (', ` +
        `'CREATE TABLE IF NOT EXISTS zzz_676_removed_attestations (');` +
        `fs.writeFileSync(p,s);`,
    ], { cwd: repo });

    const done = censusOn(repo);

    expect(done.stdout).toContain("actor_target_attestations");
    expect(done.stdout).toContain("RESULT: FAIL");
    expect(done.stdout).toContain("no longer declares");
    expect(done.status).toBe(1);
  });

  it("states in its own output what it cannot see: a write whose keyword is assembled from parts", () => {
    // The one gap round 4 chose not to close: detecting this would mean evaluating string
    // concatenation, not matching SQL-shaped text, and is out of scope for a source-text scan. The
    // honest response, per the review, is to say so in the check's own output rather than let a
    // silent zero read as "no such write exists." Printed on every run, so it is checked here on the
    // unmodified source tree's own PASS rather than a synthetic probe.
    const repo = scratchRepo();

    const done = censusOn(repo);

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.stdout).toContain("SCOPE:");
    expect(done.stdout).toContain("assembled from parts");
  });
});
