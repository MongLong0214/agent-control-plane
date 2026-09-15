#!/usr/bin/env node
/**
 * Brings `refs/notes/commitlore` into this checkout, so the gates that read records can see both
 * places a record is stored.
 *
 * `actions/checkout` does not fetch notes refs — `fetch-depth: 0` deepens the commit history and
 * brings nothing under `refs/notes/`. Without this, `pnpm trailers` runs against a checkout that
 * cannot tell a record preserved as a note from one the squash merge lost, and it refuses rather
 * than guess. That refusal is correct and it is also unactionable, which is how `8b38c9d6` left
 * `main` red over records that were never lost.
 *
 * This is setup, not a gate: it makes the evidence available and says what it found. A remote with
 * no notes ref yet is not a failure to report here — the gate is what decides whether the absence
 * matters for the commits it is asked about.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REFSPEC = "+refs/notes/commitlore:refs/notes/commitlore";

const fetched = spawnSync("git", ["fetch", "--no-tags", "origin", REFSPEC], {
  cwd: ROOT,
  encoding: "utf8",
});

if (fetched.status === 0) {
  process.stdout.write(`refs/notes/commitlore fetched from origin.\n`);
  process.exit(0);
}

// Named, never swallowed: a reader who later sees the gate say "could not see the notes ref" needs
// this line to know the fetch was attempted and what it said.
process.stdout.write(
  "refs/notes/commitlore was not fetched. The gates that read records will say so when it matters.\n" +
    `  git fetch --no-tags origin '${REFSPEC}'\n` +
    `  ${String(fetched.stderr ?? "").trim() || `exit ${String(fetched.status)}`}\n`,
);
process.exit(0);
