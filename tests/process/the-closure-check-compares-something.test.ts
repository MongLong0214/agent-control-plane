import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

/**
 * The window this check reads decides whether it checks anything.
 *
 * `verify-affected-closure-misses-nothing.mjs` compares two independent traversals of one import
 * graph, but only on changed-file sets it judges `SELECTED`. A set that touches `ci.yml`,
 * `package.json` or `verify-guards-are-falsifiable.mjs` is `FULL`, and a `FULL` verdict **skips the
 * reverse computation entirely** — the script's own footer says so. So a window full of FULL
 * verdicts is a green run that compared nothing, and it looks exactly like a green run that
 * compared everything.
 *
 * Measured 2026-09-16, which is why the default moved:
 *
 *     12 sets   7 FULL   5 SELECTED, 3 selecting 0 rows   ->  2 real comparisons, both 351/665
 *     60 sets  21 FULL  39 SELECTED, 7 selecting 0 rows   -> 32 real comparisons, 6..547 of 665
 *
 * A week of infrastructure work fills twelve commits with precisely the three FULL-forcing paths,
 * and that is the week this went unnoticed in. These read the reported set count rather than the
 * constant, because the constant is not what the run uses if the argument parsing is wrong.
 */
const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts/verify-affected-closure-misses-nothing.mjs");

const run = (args: readonly string[] = []): { status: number; stdout: string } => {
  const out = boundedSpawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: out.status ?? -1, stdout: out.stdout ?? "" };
};

/** The count the run actually read, from its own first line. */
const setsExamined = (stdout: string): number => {
  const match = /(\d+) real changed-file set\(s\)/.exec(stdout);
  return match ? Number(match[1]) : -1;
};

describe("the affected-closure check reads a window wide enough to compare something", () => {
  it("examines sixty sets by default, not twelve", () => {
    const { status, stdout } = run();
    expect(status, stdout).toBe(0);
    // Twelve is the value this moved away from and the one a later edit would most plausibly
    // restore, so the assertion names the floor rather than an exact number: a wider window is
    // fine, and anything at or below twelve is the state that measured two identical answers.
    expect(setsExamined(stdout), "the default window is back to a size that compares almost nothing")
      .toBeGreaterThan(12);
  });

  it("uses the window it is given", () => {
    // Without this, the case above passes for a script that ignores `--commits=` and hardcodes a
    // large number — the default would be right for a reason unrelated to the argument.
    expect(setsExamined(run(["--commits=5"]).stdout)).toBe(5);
  });

  it("refuses a window that is not a count", () => {
    for (const bad of ["--commits=0", "--commits=-3", "--commits=abc"]) {
      expect(run([bad]).status, `${bad} was accepted`).toBe(2);
    }
  });

  it("reports how many sets it compared rather than only that it passed", () => {
    // The distinction this whole file is about: FULL sets are listed, and a reader can count them.
    // A verdict line with no per-set accounting cannot be audited for thinness.
    const { stdout } = run(["--commits=12"]);
    expect(stdout).toMatch(/\bFULL\b/);
    expect(stdout).toMatch(/\bSELECTED\b/);
  });
});
