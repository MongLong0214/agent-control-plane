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
    // What this case does and does not witness. It runs the real census and
    // reads the line it printed, so it covers "the census completes and its
    // three totals are consistent". It does **not** witness the reconciliation
    // *refusal*: the census gates on reconciliation before printing, so any
    // CENSUS line this case can parse necessarily reconciles, and the sum
    // assertion below is downstream of that gate.
    //
    // An earlier version of this comment claimed the refusal was the kill
    // mechanism for the falsifiability row. A merge-gate review disproved it —
    // with the refusal block deleted, the row's mutation is still killed, by
    // this case's own arithmetic. The refusal is witnessed instead by
    // `tests/process/the-refusal-operand-census-derives-subjects.test.ts`,
    // which runs a copy with one total frozen in a temporary root.
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
    // Not `excluded > 0`. Emptying `FILE_EXCLUSIONS` is #833's declared goal, and an assertion
    // that goes red on the day the backlog is finished would fail under a name that promises
    // something else entirely. Zero excluded operands is a correct census; the sum above is what
    // carries the claim either way.
    expect(excluded).toBeGreaterThanOrEqual(0);
  });

  it("keeps those counts out of the headers that describe the lists", () => {
    const line = census().split("\n").find((one) => one.startsWith("CENSUS:")) ?? "";
    const match = CENSUS_LINE.exec(line);
    expect(match).not.toBeNull();
    const counted = {
      "selected operand count": match?.[1] ?? "",
      "excluded file count": match?.[2] ?? "",
      "excluded operand count": match?.[3] ?? "",
      "repository operand count": match?.[4] ?? "",
    };

    for (const path of HEADERS) {
      const header = leadingComment(path);
      for (const [what, value] of Object.entries(counted)) {
        expect(header, `${path} restates the ${what}`).not.toMatch(countedAs(value));
      }
    }
  });
});

/**
 * A file's leading block comment, and nothing after it.
 *
 * Not `split("export const")[0]`, which a merge-gate review measured as **46,870 of 47,040
 * characters** for `refusal-operands-unanswered.mjs` — its `UNANSWERED` export comes after the
 * whole data array, so that slice is the file. A bare substring test over 47KB of data collides
 * with 38 of the values the count can take, `833` and `804` among them: the tracking issue numbers
 * written in the very headers being checked, and `#833` is the issue whose completion drives the
 * count downward into its own alarm.
 */
const leadingComment = (path: string): string => {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("*/");
  return end === -1 ? "" : text.slice(0, end + 2);
};

/**
 * The number as a *restated count*, which is a number followed by what it counts.
 *
 * The property is "no header states a count that can drift from the census", not "no header
 * contains these digits". An issue reference, a line number or a date is not a restatement, and a
 * guard that cannot tell them apart fails on prose it should permit — which is worse than silence,
 * because it fails under a name that says the header is stale.
 *
 * Both spellings of thousands, because the prose that actually went stale wrote a separator.
 */
const countedAs = (value: string): RegExp => {
  const grouped = value.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const digits = value === grouped ? value : `(?:${value}|${grouped})`;
  return new RegExp(`\\b${digits}\\s+(?:unanswered\\s+|deciding\\s+)?(?:operands?|files?)\\b`, "u");
};
