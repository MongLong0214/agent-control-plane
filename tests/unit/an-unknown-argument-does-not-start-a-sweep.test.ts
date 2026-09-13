import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { runBoundedChild } from "../helpers/bounded-child.ts";

/**
 * #897. The harness reads each option by looking for the one it wants and ignoring everything
 * else, and "no selector" is how the full sweep is asked for — so an argument it does not know is
 * not a no-op, it is a hundred-minute run that mutates 83 files in the working tree.
 *
 * The decisive observable is not the exit status on its own: a failing sweep also exits nonzero.
 * It is that **stdout is empty**. Every line the run produces goes to stdout, so nothing there
 * means nothing ran, and the refusal itself is on stderr.
 *
 * The bound is the one from #872, for the reason this file exists: if the refusal ever regresses,
 * the child under test *is* the full sweep, and an unbounded call would hold this worker's event
 * loop past any per-test timeout and report the failure against some other test.
 */
const HARNESS = join(process.cwd(), "scripts/verify-guards-are-falsifiable.mjs");

const run = (argv: readonly string[]) =>
  runBoundedChild("node", [HARNESS, ...argv], { cwd: process.cwd(), budgetMs: 120_000 });

describe("an unknown argument does not start a sweep", () => {
  it.each([
    ["--help", "the one that started a sweep and left a mutant behind"],
    ["--dry-run", "a flag a reader would assume is safe"],
    ["--shrad=1/4", "a mistyped shard — the worst case, because the operator believes it narrowed"],
  ])("refuses %s (%s) without running anything", async (argument) => {
    const { status, stdout, stderr } = await run([argument]);
    expect(status).toBe(2);
    expect(stderr).toContain(`unrecognised argument(s): ${argument}`);
    // Nothing ran. Every line of a real run goes to stdout; the refusal goes to stderr.
    expect(stdout).toBe("");
  }, 180_000);

  it("names what it does know, so the message is actionable rather than only a refusal", async () => {
    const { stderr } = await run(["--nope"]);
    for (const known of ["--anchors-only", "--only=", "--shard=", "--shard-report="]) {
      expect(stderr).toContain(known);
    }
  }, 180_000);

  it("a known flag is untouched: --anchors-only still runs and still passes", async () => {
    const { status, stdout } = await run(["--anchors-only"]);
    expect(status).toBe(0);
    expect(stdout).toContain("RESULT: PASS");
  }, 180_000);

  /**
   * The control that keeps the new check from swallowing the old one. A *recognised* argument that
   * selects no row must still reach the harness's own zero-selection refusal — a different exit
   * status and a different sentence — rather than being reported as a usage error.
   */
  it("a recognised selector that matches nothing is still refused by the harness, not by this check", async () => {
    const { status, stdout, stderr } = await run(["--only=no-such-row-exists"]);
    expect(status).toBe(1);
    expect(stdout).toContain("the selection named no row, so nothing was run");
    expect(stderr).not.toContain("unrecognised argument");
  }, 180_000);
});
