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

  it("sees a restated count through the decoration these headers actually used", () => {
    // The three forms a merge-gate review injected and watched walk past the first version of this
    // guard. Asserted on the predicate rather than on the files, because the files are clean —
    // with clean headers the guard passes whether or not it can see through decoration, so the
    // files cannot witness this property. Measured: the row for this test SURVIVED until these
    // assertions existed.
    const forms = [
      "this list holds **3,479** `&&`/`||` operands, against 443 in the selected files",
      " * a list of these 86\n * files, holding 3,479\n * operands at this commit.",
      "emptying it reports the repository total (3,922 at this commit)",
    ];
    for (const form of forms) {
      const normalised = normaliseHeaderText(form);
      const hit = ["3,479", "443", "86", "3,922", "3479", "3922"].some((value) =>
        countedAs(value).test(normalised),
      );
      expect(hit, `undetected restatement: ${form}`).toBe(true);
    }

    // And the other direction, which is why the window is bounded and `#` is excluded: an issue
    // reference is not a size claim, and neither is a number that reaches its noun only by
    // stepping over another number.
    expect(countedAs("833").test(normaliseHeaderText("see #833 for the 86 files"))).toBe(false);
    expect(countedAs("443").test(normaliseHeaderText("443 and then 86 files"))).toBe(false);
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
      const header = normalisedHeader(path);
      for (const [what, value] of Object.entries(counted)) {
        expect(header, `${path} restates the ${what}`).not.toMatch(countedAs(value));
      }
    }
  });
});

/**
 * A file's leading block comment, normalised so decoration cannot hide a count.
 *
 * Not `split("export const")[0]`, which a merge-gate review measured as **46,870 of 47,040
 * characters** for `refusal-operands-unanswered.mjs` — its `UNANSWERED` export comes after the
 * whole data array, so that slice is the file.
 *
 * And not the raw comment either. The second round of the same review injected the removed prose's
 * own typography and watched three of four counts walk past the guard:
 *
 *   `**3,479** \`&&\`/\`||\` operands`   the decoration breaks the digits-then-noun adjacency
 *   `these 86\n * files`                 the block-comment continuation breaks the whitespace run
 *   a `//`-style header                   no `*\/` at all, so the old slice returned "" and the
 *                                         assertion passed against nothing — absence as compliance
 *
 * So the continuations and the decoration come out, the header collapses to one line, and a header
 * that is not a block comment **refuses** rather than reading as empty.
 */
const normalisedHeader = (path: string): string => {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("*/");
  if (end === -1) {
    throw new Error(`${path} has no leading block comment: this guard cannot see its header`);
  }
  return normaliseHeaderText(text.slice(0, end + 2));
};

/** The normalisation, separated so it can be measured on prose rather than only on this repository's files. */
const normaliseHeaderText = (header: string): string =>
  header
    // ` * ` continuations first: they sit between a number and its noun.
    .replace(/^[ \t]*\*[ \t]?/gmu, " ")
    // Every decoration the repository has used around a count — bold, backticks, brackets.
    .replace(/[^0-9A-Za-z,#\s]/gu, " ")
    .replace(/\s+/gu, " ");

/**
 * The number as a *restated count*: digits, then within a short window, what they count.
 *
 * A window rather than adjacency, because `**3,479** \`&&\`/\`||\` operands` is a restatement and
 * `3,479 operands` is the same claim with less punctuation. `[^0-9]` in the window stops the match
 * from stepping over a *different* number to find a noun.
 *
 * `(?<!#)` keeps issue references out. The headers cite `#833` and `#804`, and a count equal to
 * either would otherwise fail the guard for prose that states no size at all — the collision a
 * merge-gate review enumerated 38 values for.
 *
 * `total` is in the noun set beside `operands`/`files` because "the repository total (3,922 at
 * this commit)" is a restated count with no other noun in reach — and it is the census's own
 * wording, which is exactly the phrasing a header would copy.
 *
 * Both spellings of thousands, because the prose that actually went stale wrote a separator.
 */
const countedAs = (value: string): RegExp => {
  const grouped = value.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const digits = value === grouped ? value : `(?:${value}|${grouped})`;
  const noun = "(?:operands?|files?|total)";
  const bounded = `(?<!#)(?<!\\d)${digits}(?!\\d)`;
  // Either order. "3,479 operands" and "the repository total 3,922" are the same restatement, and
  // the second is the census's own wording — a header copying it would otherwise walk past.
  return new RegExp(`(?:${bounded}[^0-9]{0,40}?\\b${noun}\\b)|(?:\\b${noun}\\b[^0-9]{0,40}?${bounded})`, "u");
};
