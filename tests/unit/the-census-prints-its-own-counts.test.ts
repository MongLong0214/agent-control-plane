import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The operand census's two backlog lists used to restate their own size in prose, and the number
 * went stale every time a file left a list — 89, then 88, then 87. Worse than stale: three
 * branches each decremented the same literal from their own base, so the rebase conflicted on the
 * number rather than on any logic, and resolving one by adding the decrements is exactly the
 * staleness the line itself warned against.
 *
 * The census now counts the lists it loads, every run. These cases pin that: the number must come
 * from the Map, and no header may state one that can drift from it.
 */
const census = (): string =>
  execFileSync("node", ["scripts/verify-refusal-operands-are-watched.mjs"], {
    encoding: "utf8",
    timeout: 120_000,
  });

const CENSUS_LINE =
  /selected \d+ deciding file\(s\) holding (\d+) operand\(s\); excluded (\d+) deciding file\(s\) holding (\d+) unanswered operand\(s\), (\d+) in total/;

const HEADERS = [
  "scripts/lib/refusal-operand-exclusions.mjs",
  "scripts/lib/refusal-operands-unanswered.mjs",
];

describe("the census prints the counts its headers used to restate", () => {
  it("reconciles its split with the population it came from, or exits non-zero", () => {
    // The first version of this case copied the census into `scripts/`, froze a
    // number in the copy and asserted the copy refused. That copy had to sit
    // exactly one level below the repository root — `ROOT` is
    // `new URL("..", import.meta.url)` — and `scripts/` is the only such place
    // where `./lib/*` and `typescript` both resolve. It is also what
    // `tests/process/every-script-has-a-plausible-caller.test.ts` enumerates,
    // so under the full suite the two raced and that test failed on a stray
    // direct child of `scripts/`. Measured: `passes on the working tree as it
    // stands` went red with both files in one run.
    //
    // No copy is needed. The falsifiability row mutates the real file to a
    // *wrong* literal, and the census then refuses its own arithmetic — so
    // this case only has to assert that the unmutated census exits 0 and that
    // its parts sum to its whole.
    const line = census().split("\n").find((one) => one.startsWith("CENSUS:")) ?? "";
    const match = CENSUS_LINE.exec(line);
    expect(match).not.toBeNull();

    const group = (index: number): number => Number(match?.[index] ?? NaN);
    const selected = group(1);
    const excluded = group(3);
    const total = group(4);

    // A literal equal to today's value is indistinguishable from a derived one
    // on the commit that writes it — that is how the header prose survived
    // three removals looking plausible. Reconciliation is what makes a frozen
    // number detectable, and the exit code is what makes it a refusal rather
    // than a sentence nobody reads.
    expect(selected + excluded).toBe(total);
    expect(total).toBeGreaterThan(0);
    expect(selected).toBeGreaterThan(0);
    expect(excluded).toBeGreaterThan(0);
  });

  it("keeps those counts out of the headers that describe the lists", () => {
    const line = census().split("\n").find((one) => one.startsWith("CENSUS:")) ?? "";
    const match = /excluded (\d+) deciding file\(s\) holding (\d+) unanswered operand\(s\)/.exec(line);
    const files = match?.[1] ?? "";
    const operands = match?.[2] ?? "";
    // Both spellings, because the prose that went stale wrote thousands with a separator.
    const grouped = operands.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

    for (const path of HEADERS) {
      const header = readFileSync(path, "utf8").split("export const")[0] ?? "";
      // A file that states today's true count is the failure: it is true now and silently wrong
      // at the next removal, which is when someone is reading it to decide what to do next.
      expect(header, `${path} restates the operand count`).not.toContain(operands);
      expect(header, `${path} restates the operand count`).not.toContain(grouped);
      expect(header, `${path} restates the excluded file count`).not.toMatch(
        new RegExp(`${files}\\s+(?:deciding\\s+)?files?`),
      );
    }
  });
});
