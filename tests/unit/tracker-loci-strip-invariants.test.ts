import { describe, expect, it } from "vitest";
import {
  blankKeepingNewlines,
  stripHashComments,
  stripPythonSource,
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
  {
    label: "a Python triple-quoted docstring containing a # character (#700)",
    text: ['"""Built and proved for #419.', "Not a comment — inside the docstring.", '"""', "x = 1"].join("\n"),
  },
  {
    label: "a Python triple-quoted string using single-quote delimiters",
    text: ["'''", "line one", "line two", "'''", "y = 2"].join("\n"),
  },
  {
    label: "an unterminated Python triple-quoted string (no closing \"\"\")",
    text: ['"""this never closes', "line 2", "line 3"].join("\n"),
  },
  {
    label: "a Python triple-quoted string containing an escaped quote",
    text: ['x = """line one \\"\\"\\" still inside', 'line two"""', "y = 1"].join("\n"),
  },
  {
    label: "adjacent Python triple-quoted strings of different delimiter styles",
    text: ['a = """first"""', "b = '''second'''", "c = 3"].join("\n"),
  },
];

const strippers: Array<{ name: string; fn: (text: string) => string }> = [
  { name: "blankKeepingNewlines", fn: blankKeepingNewlines },
  { name: "stripSlashComments", fn: stripSlashComments },
  { name: "stripHashComments", fn: stripHashComments },
  { name: "stripSqlComments", fn: stripSqlComments },
  { name: "stripStrings", fn: stripStrings },
  { name: "stripTemplateLiteralProse", fn: stripTemplateLiteralProse },
  // #700: the two call sites `stripPythonSource` actually serves — see its own comment for why
  // they need opposite answers about string content — each get their own row so this property
  // (line-count preservation) is asserted for both, not just the one a caller happened to reach.
  { name: "stripPythonSource(blankStrings=true)", fn: (text) => stripPythonSource(text, true) },
  { name: "stripPythonSource(blankStrings=false)", fn: (text) => stripPythonSource(text, false) },
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

  describe("stripPythonSource (#700)", () => {
    it("pairs a triple-quoted docstring as one delimiter, not three single quotes, and does not desync what follows", () => {
      // The exact shape of the reported bug: a triple-quoted string ahead of real code. The old
      // stripStrings(stripHashComments(text)) pipeline read the opening `"""` as an empty string
      // followed by a fresh opening quote, corrupting every quote pairing after it.
      const input = ['"""', "a docstring", '"""', 'x = "real value"'].join("\n");
      const out = stripPythonSource(input, true);
      const lines = out.split("\n");
      expect(lines[3]).toBe('x = "          "');
    });

    it("a # inside a triple-quoted string is not read as a comment marker", () => {
      const input = ['"""built and proved for #419."""', "y = 1"].join("\n");
      const out = stripPythonSource(input, true);
      // The digits survive (blanked to spaces like the rest of the string interior, not cut off
      // the way a real comment would be) and the following line is untouched.
      expect(out.split("\n")[1]).toBe("y = 1");
    });

    it("blankStrings=true blanks string content but keeps the delimiters", () => {
      const out = stripPythonSource('x = "secret"', true);
      expect(out.startsWith('x = "')).toBe(true);
      expect(out.endsWith('"')).toBe(true);
      expect(out).not.toContain("secret");
      expect(out.length).toBe('x = "secret"'.length);
    });

    it("blankStrings=false leaves string content untouched, comments still stripped", () => {
      const input = 'x = "secret"  # a comment';
      const out = stripPythonSource(input, false);
      expect(out.startsWith('x = "secret"')).toBe(true);
      expect(out).not.toContain("# a comment");
      expect(out.length).toBe(input.length);
    });

    it("single-quote and triple-single-quote strings are each paired at the right width", () => {
      const input = ["a = 'short'", "b = '''", "multi", "line", "'''"].join("\n");
      const out = stripPythonSource(input, true);
      const lines = out.split("\n");
      expect(lines[0]).toBe("a = '     '");
      expect(lines[1]).toBe("b = '''");
      expect(lines[2]).toBe("     ");
      expect(lines[3]).toBe("    ");
      expect(lines[4]).toBe("'''");
    });

    it("an escaped quote inside a triple-quoted string does not end it early", () => {
      const input = 'x = """line \\""" still inside"""';
      const out = stripPythonSource(input, true);
      // The escaped `\"` does not close the triple-quote three characters early; the real closing
      // `"""` is the one at the very end.
      expect(out.endsWith('"""')).toBe(true);
      expect(out.startsWith('x = """')).toBe(true);
    });

    it("the real deploy/egress/allowlist-proxy.py: line 77 survives the module docstring above it", () => {
      // The concrete counterexample #700 reported: ALLOWLIST_DIGEST's own declaration, corrupted
      // by the module's triple-quoted docstring under the old pipeline.
      const fs = require("node:fs");
      const path = require("node:path");
      const text = fs.readFileSync(
        path.join(__dirname, "..", "..", "deploy", "egress", "allowlist-proxy.py"),
        "utf8",
      );
      const symbolView = stripPythonSource(text, true);
      expect(symbolView.split("\n")[76]).toContain("ALLOWLIST_DIGEST");
      const contentView = stripPythonSource(text, false);
      expect(contentView.split("\n")[76]).toBe(
        '    ALLOWLIST_DIGEST = "sha256:" + hashlib.sha256(_f.read()).hexdigest()',
      );
    });
  });
});
