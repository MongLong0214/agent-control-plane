import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A gate that writes to a tracked source file, and what happens when it does not finish.
 *
 * `verify-migrations-are-immutable.mjs` classifies each migration by observation: it appends a
 * comment to `src/db/schema.sql` and sees whose checksum moves. That answer cannot be had any
 * other way — a hand-maintained list of which migrations read the schema is the kind of list this
 * repository has watched go stale twice — but it means a real source file is altered for the width
 * of one synchronous call.
 *
 * A `finally` covers a thrown error. It does not cover SIGKILL, and this repository has already
 * had a mutation survive a killed process and reach a commit. So the original is parked on disk
 * first, and the next run puts it back before reading anything.
 *
 * Run against a copy of the repository rather than the repository: a test that deliberately leaves
 * the schema altered must not be able to leave *this* one altered if it fails halfway.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-migrations-are-immutable.mjs";
const MANIFEST = "src/db/migration-checksums.json";

/** A throwaway clone, with the working tree and node_modules the script needs. */
const scratchRepo = (): string => {
  const dir = join(tempDir("acp-schema-probe-"), "repo");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--depth", "1", ROOT, dir]);
  execFileSync("ln", ["-sfn", join(ROOT, "node_modules"), join(dir, "node_modules")]);
  // The clone carries the committed script; this test is about the one in the working tree. Its
  // first version measured the old script and passed on the wrong evidence — the repair it was
  // asserting on had not been written into what it ran.
  copyFileSync(join(ROOT, SCRIPT), join(dir, SCRIPT));
  // And the manifest it is checked against. The clone carries the committed pair; changing how the
  // script classifies a migration changes which ids belong in the manifest, so copying one without
  // the other measures a script against an answer key written for a different script.
  copyFileSync(join(ROOT, MANIFEST), join(dir, MANIFEST));
  return dir;
};

describe("the migration gate puts schema.sql back", () => {
  it("repairs a schema an abandoned run left altered, before it reads anything", () => {
    const repo = scratchRepo();
    const schema = join(repo, "src/db/schema.sql");
    const original = readFileSync(schema, "utf8");

    // Exactly what a SIGKILL between the write and the restore leaves: an altered schema and the
    // original parked beside it.
    const parked = join(repo, ".git/schema-probe-in-flight");
    copyFileSync(schema, parked);
    writeFileSync(schema, `${original}\n-- an abandoned probe left this behind\n`);

    const done = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8" });

    expect(done.stdout).toContain("died mid-probe");
    expect(readFileSync(schema, "utf8")).toBe(original);
    expect(existsSync(parked)).toBe(false);
    // And the run it repaired still answers, rather than refusing because it had to clean up.
    expect(done.stdout).toContain("RESULT: PASS");
  });

  it("leaves nothing behind on an ordinary run", () => {
    const repo = scratchRepo();
    const schema = join(repo, "src/db/schema.sql");
    const original = readFileSync(schema, "utf8");

    const done = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8" });

    expect(done.status).toBe(0);
    expect(readFileSync(schema, "utf8")).toBe(original);
    expect(existsSync(join(repo, ".git/schema-probe-in-flight"))).toBe(false);
  });

  it("does not report a clean result from a schema the probe altered", () => {
    // The repair runs before the import that reads the schema. Without that ordering every
    // migration's checksum would be measured against the leftover probe rather than the schema,
    // and the answer would be about a file nobody wrote on purpose.
    const repo = scratchRepo();
    const schema = join(repo, "src/db/schema.sql");
    const original = readFileSync(schema, "utf8");
    copyFileSync(schema, join(repo, ".git/schema-probe-in-flight"));
    writeFileSync(schema, `${original}\n-- leftover\n`);

    spawnSync("node", [SCRIPT, "--update"], { cwd: repo, encoding: "utf8" });
    const frozen = readFileSync(join(repo, "src/db/migration-checksums.json"), "utf8");

    rmSync(join(repo, ".git/schema-probe-in-flight"), { force: true });
    writeFileSync(schema, original);
    const after = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8" });

    // The freeze it wrote has to agree with the unaltered schema, which it only does if the repair
    // happened first.
    expect(frozen).toContain("sha256:");
    expect(after.stdout).toContain("RESULT: PASS");
  });
});
