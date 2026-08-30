import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("the turn-fence writer census sees a writer outside the coordinator", () => {
  it("fails when a new file writes canonical_turns directly", () => {
    const repo = scratchRepo();
    mkdirSync(join(repo, "src/probe"), { recursive: true });
    writeFileSync(
      join(repo, "src/probe/rogue-writer-676.ts"),
      [
        "// Synthetic writer-72 probe for issue #676.",
        'import type { Db } from "../db/database.ts";',
        "",
        "export const rogueSettle = (db: Db, turnRequestId: string): void => {",
        "  db.run(`UPDATE canonical_turns SET lifecycle_state = 'SETTLED' WHERE turn_request_id = ?`, [",
        "    turnRequestId,",
        "  ]);",
        "};",
        "",
      ].join("\n"),
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
    mkdirSync(join(repo, "src/probe"), { recursive: true });
    writeFileSync(
      join(repo, "src/probe/rogue-attester-676.ts"),
      [
        "// Synthetic writer-72 probe for issue #676.",
        'import type { Db } from "../db/database.ts";',
        "",
        "export const rogueAttest = (db: Db): void => {",
        "  db.run(`INSERT INTO actor_target_attestations (target_attestation_id) VALUES (?)`, [\"x\"]);",
        "};",
        "",
      ].join("\n"),
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
});
