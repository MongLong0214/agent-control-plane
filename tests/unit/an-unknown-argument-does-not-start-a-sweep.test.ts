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

  /**
   * The allow-list and the flags it guards must agree, and this is the check that was missing.
   *
   * `--print-rows` and this refusal landed in two pull requests. Each was green on its own; merged
   * in sequence they broke each other, because the second one's merge ref was built before the
   * first one landed and GitHub does not rebuild it on a base change. On `main` the result was a
   * flag the harness implements and its own argument check refuses — three of its tests red, and
   * nothing had failed anywhere before the merge.
   *
   * So the two are reconciled from the source rather than remembered: every `--flag` this file
   * reads out of `process.argv` has to appear in the list, and the list has to name only flags it
   * reads. A count that has to sum is the only form of this that survives a second author.
   */
  it("names every flag the harness actually reads, and no others", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(HARNESS.replace(/^/, ""), "utf8");

    const read = new Set<string>();
    for (const match of source.matchAll(/process\.argv\.includes\("(--[a-z-]+)"\)/g)) read.add(match[1]!);
    for (const match of source.matchAll(/startsWith\("(--[a-z-]+=)"\)/g)) read.add(match[1]!);
    // The allow-list's own two arrays are written in terms of these, so exclude the declarations
    // themselves from what counts as a read.
    const declared = new Set<string>();
    for (const block of source.matchAll(/const KNOWN_(?:FLAGS|VALUED_ARGUMENTS) = \[([^\]]*)\]/g)) {
      for (const one of block[1]!.matchAll(/"(--[a-z-]+=?)"/g)) declared.add(one[1]!);
    }

    expect(declared.size, "the harness declares no known arguments at all").toBeGreaterThan(3);
    expect([...read].sort(), "a flag the harness reads is missing from the allow-list").toEqual(
      [...declared].sort(),
    );
  }, 60_000);
});
