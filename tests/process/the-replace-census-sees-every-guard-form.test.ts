import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The census that could not see the shape that mattered.
 *
 * Four of this schema's most load-bearing guards are written `BEFORE UPDATE OF <column> ON <table>`,
 * and the census's first pattern matched only `BEFORE UPDATE ON <table>`. Sixteen triggers were
 * invisible to it, `sessions` among them — a table whose secret hash an `INSERT OR REPLACE`
 * rewrote on ACP's own connection while the census printed PASS.
 *
 * A check that cannot see a shape cannot report it, and nothing about its output says which shapes
 * it can see. So the census is run against a schema built to contain exactly that shape, and
 * required to fail.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-append-only-tables-are-closed.mjs";

/** A throwaway clone carrying the working-tree census, so this measures the script being edited. */
const scratchRepo = (): string => {
  const dir = join(tempDir("acp-census-"), "repo");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--depth", "1", ROOT, dir]);
  copyFileSync(join(ROOT, SCRIPT), join(dir, SCRIPT));
  copyFileSync(join(ROOT, "src/db/schema.sql"), join(dir, "src/db/schema.sql"));
  return dir;
};

const censusOn = (schema: string): { status: number | null; stdout: string } => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "src/db/schema.sql"), schema);
  const done = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout };
};

const CURRENT = () => readFileSync(join(ROOT, "src/db/schema.sql"), "utf8");

describe("the REPLACE census reports a table guarded in the form it could not see", () => {
  it("fails on a table whose only guard is BEFORE UPDATE OF a column", () => {
    const injected = `${CURRENT()}
CREATE TABLE IF NOT EXISTS census_probe_table (
  probe_id TEXT PRIMARY KEY,
  secret   TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS census_probe_secret_immutable
BEFORE UPDATE OF secret ON census_probe_table
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_IMMUTABLE');
END;
`;
    const done = censusOn(injected);

    expect(done.stdout).toContain("census_probe_table");
    expect(done.status).toBe(1);
  });

  it("is not satisfied by an INSERT trigger that is a validator rather than a REPLACE guard", () => {
    // The first version skipped any table carrying any BEFORE INSERT trigger, which exempted two
    // tables for holding shape validators — triggers that say nothing about a key already present.
    const injected = `${CURRENT()}
CREATE TABLE IF NOT EXISTS census_probe_table (
  probe_id TEXT PRIMARY KEY,
  secret   TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS census_probe_secret_immutable
BEFORE UPDATE OF secret ON census_probe_table
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS census_probe_secret_required
BEFORE INSERT ON census_probe_table
WHEN NEW.secret = ''
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_SECRET_REQUIRED');
END;
`;
    const done = censusOn(injected);

    expect(done.stdout).toContain("census_probe_table");
    expect(done.status).toBe(1);
  });

  it("passes on the schema as it stands, so the two failures above are about the probe", () => {
    const done = censusOn(CURRENT());

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.status).toBe(0);
  });
});

describe("a no_replace trigger has to name what a REPLACE would collide on", () => {
  it("fails on a guard that names none of its table's keys", () => {
    // The guard exists, is named correctly, and refuses nothing. Its presence used to be all the
    // census asked for — a check satisfied by a name.
    const injected = `${CURRENT()}
CREATE TABLE IF NOT EXISTS census_probe_table (
  probe_id TEXT PRIMARY KEY
);

CREATE TRIGGER IF NOT EXISTS census_probe_immutable
BEFORE UPDATE OF probe_id ON census_probe_table
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS census_probe_table_no_replace
BEFORE INSERT ON census_probe_table
WHEN 1 = 2
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_NO_REPLACE');
END;
`;
    const done = censusOn(injected);

    expect(done.stdout).toContain("census_probe_table");
    expect(done.status).toBe(1);
  });

  it("fails on a guard that names only part of a composite key", () => {
    // Naming less than the key refuses legitimate inserts — measured once, on a registry whose
    // rotation this shape blocked — and naming a key that is not the whole one lets the collision
    // it was written for through.
    const injected = `${CURRENT()}
CREATE TABLE IF NOT EXISTS census_probe_table (
  left_id  TEXT NOT NULL,
  right_id TEXT NOT NULL,
  PRIMARY KEY (left_id, right_id)
);

CREATE TRIGGER IF NOT EXISTS census_probe_immutable
BEFORE UPDATE OF left_id ON census_probe_table
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS census_probe_table_no_replace
BEFORE INSERT ON census_probe_table
WHEN EXISTS (SELECT 1 FROM census_probe_table WHERE left_id = NEW.left_id)
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_NO_REPLACE');
END;
`;
    const done = censusOn(injected);

    expect(done.stdout).toContain("census_probe_table");
    expect(done.status).toBe(1);
  });
});

describe("a partial unique index is a key the census demands too", () => {
  it("fails on a guard that ignores a partial index's predicate", () => {
    // Dropping partial indexes from the rule leaves a real hole: measured, a REPLACE colliding
    // inside `WHERE state = 'ACTIVE'` deleted the existing row and said nothing. Keeping the
    // columns without the predicate refuses legitimate inserts instead — fifty-seven of them.
    // The rule takes both, so the census has to demand both.
    const injected = `${CURRENT()}
CREATE TABLE IF NOT EXISTS census_probe_table (
  probe_id TEXT PRIMARY KEY,
  owner    TEXT NOT NULL,
  state    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS census_probe_active_owner
  ON census_probe_table(owner) WHERE state = 'ACTIVE';

CREATE TRIGGER IF NOT EXISTS census_probe_immutable
BEFORE UPDATE OF owner ON census_probe_table
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS census_probe_table_no_replace
BEFORE INSERT ON census_probe_table
WHEN EXISTS (SELECT 1 FROM census_probe_table WHERE probe_id = NEW.probe_id)
BEGIN
  SELECT RAISE(ABORT, 'CENSUS_PROBE_NO_REPLACE');
END;
`;
    const done = censusOn(injected);

    expect(done.stdout).toContain("census_probe_table");
    expect(done.stdout).toContain("where state = 'ACTIVE'");
    expect(done.status).toBe(1);
  });
});
