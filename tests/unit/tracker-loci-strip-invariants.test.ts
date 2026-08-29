import { describe, expect, it } from "vitest";
import {
  blankKeepingNewlines,
  stripHashComments,
  stripSlashComments,
  stripSqlComments,
  stripStrings,
  stripTemplateLiteralProse,
} from "../../scripts/lib/tracker-loci-strip.mjs";

/**
 * Round 11 fixed one instance of a general defect: `readCode`'s output is sliced by line number
 * (the content-search window) as well as searched as a whole (the symbol search), so every one of
 * these strippers has to preserve `text.split("\n").length` — a stripper that collapses a
 * multi-line span shifts every line after it out of sync with the real file. That round fixed the
 * one instance a real corpus citation happened to expose (a multi-line `/* ... *\/` block comment
 * ahead of the cited line). This file asserts the *general* property, over inputs constructed to
 * be adversarial for each stripper rather than ones a corpus snapshot happened to contain — a
 * clean corpus diff proves the corpus does not currently exercise a shape, not that the shape is
 * handled (see the round 11 commit).
 *
 * Every input below is run against every stripper, not just the one it was designed to challenge:
 * the property is supposed to hold universally, and restricting each input to "its" function would
 * just be a narrower version of the same corpus-shaped blind spot.
 */
const ADVERSARIAL_INPUTS: Array<{ label: string; text: string }> = [
  {
    label: "nested template literals, multi-line",
    text: ["const a = `outer", "${`inner", "value ${x}`}", "end`;", "const b = 1;"].join("\n"),
  },
  {
    label: "an odd (unbalanced) double-quote count",
    text: [
      'This has one lone quote: " and continues',
      "on another line, and eventually",
      'a real "string" appears here, followed by more text.',
    ].join("\n"),
  },
  {
    label: "an odd (unbalanced) single-quote count",
    text: [
      "This has a contraction's apostrophe acting like an opening quote,",
      "spanning down to",
      "the 'real' string here.",
    ].join("\n"),
  },
  {
    label: "an escaped multi-line string (backslash line-continuation)",
    text: ['const a = "line one \\', 'line two";', "const b = 2;"].join("\n"),
  },
  {
    label: "an escaped multi-line template literal (backslash line-continuation)",
    text: ["const a = `line one \\", "line two`;", "const b = 3;"].join("\n"),
  },
  {
    label: "a /* */ block comment spanning many lines",
    text: ["const a = 1;", "/*", " * line 2", " * line 3", " * line 4", " */", "const b = 2;"].join("\n"),
  },
  {
    label: "a // line comment at end of file with no trailing newline",
    text: "const a = 1;\n// trailing comment, no newline after this",
  },
  {
    label: "a -- SQL line comment at end of file with no trailing newline",
    text: "SELECT 1;\n-- trailing comment, no newline after this",
  },
  {
    label: "a # hash comment at end of file with no trailing newline",
    text: "x = 1\n# trailing comment, no newline after this",
  },
  {
    label: "an unterminated /* block comment (no closing */)",
    text: ["const a = 1;", "/* this never closes", "line 2", "line 3"].join("\n"),
  },
  {
    label: "an unterminated backtick (no closing `)",
    text: ["const a = `this never closes", "line 2", "line 3"].join("\n"),
  },
  {
    label: "an unterminated double-quoted string (no closing \")",
    text: ['const a = "this never closes', "line 2", "line 3"].join("\n"),
  },
  {
    label: "empty string",
    text: "",
  },
  {
    label: "plain text with no special characters at all",
    text: "line one\nline two\nline three",
  },
  {
    label: "a string literal containing a URL (:// must not be misread as a line comment)",
    text: 'const a = "https://example.com/path";\nconst b = 2;',
  },
];

const strippers: Array<{ name: string; fn: (text: string) => string }> = [
  { name: "blankKeepingNewlines", fn: blankKeepingNewlines },
  { name: "stripSlashComments", fn: stripSlashComments },
  { name: "stripHashComments", fn: stripHashComments },
  { name: "stripSqlComments", fn: stripSqlComments },
  { name: "stripStrings", fn: stripStrings },
  { name: "stripTemplateLiteralProse", fn: stripTemplateLiteralProse },
];

describe("tracker-loci strip invariants", () => {
  for (const { name, fn } of strippers) {
    describe(name, () => {
      for (const { label, text } of ADVERSARIAL_INPUTS) {
        it(`preserves line count: ${label}`, () => {
          const inputLines = text.split("\n").length;
          const outputLines = fn(text).split("\n").length;
          expect(outputLines).toBe(inputLines);
        });
      }
    });
  }

  it("blankKeepingNewlines preserves every newline and blanks everything else", () => {
    const input = "ab\ncd\n\nef";
    expect(blankKeepingNewlines(input)).toBe("  \n  \n\n  ");
  });

  it("stripTemplateLiteralProse still substitutes real code inside ${...} verbatim, newlines included", () => {
    const input = ["`before", "${a", "  + b}", "after`"].join("\n");
    const out = stripTemplateLiteralProse(input);
    expect(out).toContain("a\n  + b");
    expect(out.split("\n").length).toBe(input.split("\n").length);
  });
});
