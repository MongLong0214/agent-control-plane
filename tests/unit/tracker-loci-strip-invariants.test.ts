import { describe, expect, it } from "vitest";
import {
  blankKeepingNewlines,
  stripHashComments,
  stripJsSource,
  stripPythonSource,
  stripShellSource,
  stripSlashComments,
  stripSqlComments,
  stripSqlSource,
  stripStrings,
  stripTemplateLiteralProse,
  stripYamlSource,
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
    label: "a regex literal containing quotes, comment markers, and a character-class slash",
    text: ['const pattern = /["\'/*]/u;', "const afterRegex = 1;"].join("\n"),
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
  {
    label: "a heredoc body spanning many lines (#689 round 16)",
    text: ["cat <<'EOF'", "line one", "line two", "line three", "EOF", "x=1"].join("\n"),
  },
  {
    label: "an unterminated heredoc (no matching delimiter line)",
    text: ["cat <<'EOF'", "never", "terminates"].join("\n"),
  },
  {
    label: "a YAML single-quoted scalar with a doubled '' escape, multi-line",
    text: ["key: 'it''s", "still one scalar'", "key2: value"].join("\n"),
  },
  {
    label: "a SQL /* */ block comment that does not nest (#689 round 17)",
    text: ["SELECT 1;", "/* outer /* inner */ still-code", "*/", "SELECT 2;"].join("\n"),
  },
  {
    label: "a SQL '...' string spanning multiple raw lines (valid SQLite, unlike JS/shell)",
    text: ["SELECT 'line one", "line two' AS v;", "SELECT 2;"].join("\n"),
  },
  {
    label: "an unterminated SQL string literal",
    text: ["SELECT 'never closes", "line 2", "line 3"].join("\n"),
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
  // #689/round 15: `stripJsSource` replaces the three-function JS/TS pipeline with one ordered
  // walk — same reason `stripPythonSource` gets its own two rows above, not just one call site.
  { name: "stripJsSource(blankStrings=true)", fn: (text) => stripJsSource(text, true) },
  { name: "stripJsSource(blankStrings=false)", fn: (text) => stripJsSource(text, false) },
  // #689/round 16: shell and YAML each get their own ordered walk — same reason as the two rows
  // above, not just one call site each.
  { name: "stripShellSource(blankStrings=true)", fn: (text) => stripShellSource(text, true) },
  { name: "stripShellSource(blankStrings=false)", fn: (text) => stripShellSource(text, false) },
  { name: "stripYamlSource(blankStrings=true)", fn: (text) => stripYamlSource(text, true) },
  { name: "stripYamlSource(blankStrings=false)", fn: (text) => stripYamlSource(text, false) },
  // #689/round 17: SQL gets its own ordered walk too — the fifth and last dispatch, same reason
  // as every row above, not just one call site each.
  { name: "stripSqlSource(blankStrings=true)", fn: (text) => stripSqlSource(text, true) },
  { name: "stripSqlSource(blankStrings=false)", fn: (text) => stripSqlSource(text, false) },
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

  describe("stripJsSource (#689, round 15)", () => {
    // Every delimiter-ordering shape this class of bug can take, each its own row rather than one
    // broad assertion — the same discipline round 11's property test above uses, and the one a
    // prior round of this exact script was blocked for skipping.

    it("// inside a string is not read as a comment marker", () => {
      // The real shape #689 found: no `://` before the `//`, the one case the old
      // `stripSlashComments` lookbehind protected — everything else fell through.
      const input = 'const a = "a//b";\nconst c = 1;';
      expect(stripJsSource(input, true)).toBe('const a = "    ";\nconst c = 1;');
      expect(stripJsSource(input, false)).toBe(input); // content view: string left untouched
    });

    it("a quote inside a genuine // comment does not open a string", () => {
      const input = "// this isn't \"real\" code\nconst a = 1;";
      const symbolView = stripJsSource(input, true);
      const contentView = stripJsSource(input, false);
      expect(symbolView).toBe("\nconst a = 1;");
      expect(contentView).toBe("\nconst a = 1;");
    });

    it("a quote inside a /* */ comment does not open a string", () => {
      const input = '/* say "hi" and \'bye\' */\nconst a = 1;';
      const out = stripJsSource(input, true);
      expect(out).not.toContain('"');
      expect(out).not.toContain("'");
      expect(out.split("\n")[1]).toBe("const a = 1;");
    });

    it("a /* */ span inside a string is string content, not a comment", () => {
      const input = 'const a = "a/*b*/c";\nconst d = 2;';
      expect(stripJsSource(input, true)).toBe('const a = "       ";\nconst d = 2;');
      expect(stripJsSource(input, false)).toBe(input);
    });

    it("a template literal's ${...} expression containing a quote resolves the nested string", () => {
      const input = '`text ${"a"} more`;\nconst z = 3;';
      expect(stripJsSource(input, true)).toBe('`     ${" "}     `;\nconst z = 3;');
      expect(stripJsSource(input, false)).toBe(input);
    });

    it("an escaped quote inside a string does not end it early", () => {
      const input = 'const a = "a\\"b";\nconst c = 4;';
      // The escaped `\"` does not close the string one character early; the real closing `"` is
      // the one right before `;`. If it ended early, the un-blanked remainder (`b";`) would
      // survive as unstripped code instead of being folded into the blanked interior.
      expect(stripJsSource(input, true)).toBe('const a = "    ";\nconst c = 4;');
    });

    it("an unterminated string is blanked to where it actually ends, not left unrecognized", () => {
      const input = 'const a = "never closes\nconst b = 6;';
      const out = stripJsSource(input, true);
      expect(out.split("\n")[0]).toBe('const a = "            ');
      expect(out.split("\n")[1]).toBe("const b = 6;"); // unaffected — the newline still ended it
    });

    it("a } that closes a string inside ${...} does not end the expression early", () => {
      const input = '`x ${ x || "}" } y`;\nconst z = 13;';
      const out = stripJsSource(input, true);
      expect(out).toContain('${ x ||');
      expect(out.split("\n")[1]).toBe("const z = 13;"); // the real end was reached, not miscounted
    });

    it("a regex literal shields quotes comment markers and character class slashes", () => {
      const input = 'const pattern = /["\'/*]\\/\\//giu;\nconst afterRegex = 14;';
      const symbolView = stripJsSource(input, true);
      expect(symbolView.split("\n")[0]).toBe("const pattern = /          /   ;");
      expect(symbolView.split("\n")[1]).toBe("const afterRegex = 14;");
      expect(stripJsSource(input, false)).toBe(input);
    });

    it("division does not open a regex literal", () => {
      const input = 'const ratio = numerator / denominator; const afterDivision = "still code";';
      const out = stripJsSource(input, true);
      expect(out).toContain("numerator / denominator");
      expect(out).toContain("afterDivision");
      expect(out).not.toContain("still code");
    });

    it("regex literals start after expression prefixes and a closed control condition", () => {
      const input = [
        "const assigned = /a/;",
        "const returned = () => /b/;",
        "if (assigned) /c/.test(returned);",
        "const divided = assigned / 2;",
      ].join("\n");
      const out = stripJsSource(input, true);
      expect(out).toContain("const assigned = / /;");
      expect(out).toContain("const returned = () => / /;");
      expect(out).toContain("if (assigned) / /.test(returned);");
      expect(out).toContain("const divided = assigned / 2;");
    });

    it("a regex literal inside a template expression cannot close the expression with its pattern", () => {
      const input = '`before ${/[}"\']/u.test(value)} after`;\nconst afterTemplateRegex = 15;';
      const out = stripJsSource(input, true);
      expect(out).toContain("${/     / .test(value)}");
      expect(out.split("\n")[1]).toBe("const afterTemplateRegex = 15;");
    });

    it("a Node hashbang is a comment rather than a symbol occurrence", () => {
      const input = "#!/usr/bin/env node --commentOnlyInterpreterSymbol\nconst liveHashbangFollower = 16;";
      const out = stripJsSource(input, true);
      expect(out).not.toContain("commentOnlyInterpreterSymbol");
      expect(out.split("\n")[1]).toBe("const liveHashbangFollower = 16;");
    });

    it("the real tests/integration/pipeline.test.ts:184 shape: module.exports inside a string with an embedded // is blanked, not left visible", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const text = fs.readFileSync(
        path.join(__dirname, "..", "integration", "pipeline.test.ts"),
        "utf8",
      );
      const symbolView = stripJsSource(text, true);
      expect(symbolView).not.toContain("module.exports");
      const contentView = stripJsSource(text, false);
      expect(contentView).toContain('module.exports = () => 2; // addressed review');
    });

    it("the real cli adapters regex leaves all later declarations visible", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const text = fs.readFileSync(path.join(__dirname, "..", "..", "src", "runtime", "cli-adapters.ts"), "utf8");
      const symbolView = stripJsSource(text, true);
      expect(symbolView).toContain("ManagedWriteScope");
      expect(symbolView).toContain("managedWriteScope");
      expect(symbolView).toContain("ClaudeCliAdapter");
    });
  });

  describe("stripShellSource (#689, round 16)", () => {
    // Every delimiter-ordering shape this class of bug can take, for shell's own delimiter set —
    // `#` comments, single quotes, double quotes, `$'...'`, and heredocs — each its own row.

    it("# starts a comment at the start of a line", () => {
      const input = "# a real comment\nx=1";
      expect(stripShellSource(input, true)).toBe("\nx=1");
    });

    it("# starts a comment after whitespace (a real word boundary)", () => {
      const input = "echo foo # trailing comment\nx=2";
      expect(stripShellSource(input, true)).toBe("echo foo \nx=2");
    });

    it("# does NOT start a comment mid-word — echo foo#bar is not a comment", () => {
      const input = "echo foo#bar\nx=3";
      expect(stripShellSource(input, true)).toBe(input); // untouched: no comment, no string
    });

    it("#689 round 18: # starts a comment right after ; with no whitespace between them", () => {
      const input = "x=1;# commentOnlySymbol\ny=2";
      expect(stripShellSource(input, true)).toBe("x=1;\ny=2");
    });

    it("#689 round 18: # starts a comment right after | with no whitespace between them", () => {
      const input = "echo foo|# commentOnlySymbol\ny=2";
      expect(stripShellSource(input, true)).toBe("echo foo|\ny=2");
    });

    it("#689 round 18: # starts a comment right after &, (, and ) with no whitespace between them", () => {
      expect(stripShellSource("cmd &# bg comment\ny=2", true)).toBe("cmd &\ny=2");
      expect(stripShellSource("(# subshell comment\ny=2", true)).toBe("(\ny=2");
      expect(stripShellSource("foo)# close comment\ny=2", true)).toBe("foo)\ny=2");
    });

    it("$# (positional parameter count) is not misread as a comment", () => {
      // The real shape in deploy/install-launchd.sh:49.
      const input = "while [[ $# -gt 0 ]]; do\nx=4";
      expect(stripShellSource(input, true)).toBe(input);
    });

    it("## (suffix-removal parameter expansion) is not misread as a comment", () => {
      // The real shape in deploy/install-launchd.sh:95 and :106.
      const input = 'mode="${metadata##* }"\nx=5';
      expect(stripShellSource(input, true)).toBe('mode="               "\nx=5');
    });

    it("8# (arithmetic base notation) is not misread as a comment", () => {
      // The real shape in deploy/install-launchd.sh:121.
      const input = "[[ $((8#22)) -eq 0 ]]\nx=6";
      expect(stripShellSource(input, true)).toBe(input);
    });

    it("// inside a string is not read as a comment marker", () => {
      // The real shape in deploy/install-launchd.sh:173: printf '#!/bin/bash\\n...\\n' — the # is
      // preceded by the opening quote, not whitespace, and is string content either way.
      const input = "printf '#!/bin/bash\\nset -e\\n'\nx=7";
      expect(stripShellSource(input, true)).toBe("printf '                     '\nx=7");
      expect(stripShellSource(input, false)).toBe(input);
    });

    it("a quote inside a genuine # comment does not open a string", () => {
      const input = "# this isn't \"real\" code\nx=8";
      expect(stripShellSource(input, true)).toBe("\nx=8");
    });

    it("a plain single-quoted string has no escape character — backslash is literal", () => {
      const input = "echo 'a\\'\nx=9";
      // The backslash does not escape the closing quote; the string is 'a\' (2 interior chars).
      expect(stripShellSource(input, true)).toBe("echo '  '\nx=9");
    });

    it("$'...' (ANSI-C quoting) does recognize backslash escapes", () => {
      const input = "echo $'a\\'b'\nx=10";
      // Unlike a plain '...', the escaped quote here does not end the string early.
      expect(stripShellSource(input, true)).toBe("echo $'    '\nx=10");
    });

    it("a double-quoted string recognizes backslash escapes", () => {
      const input = 'echo "a\\"b"\nx=11';
      expect(stripShellSource(input, true)).toBe('echo "    "\nx=11');
    });

    it("an unterminated single-quoted string is blanked to where it actually ends", () => {
      const input = "echo 'never closes\nx=12";
      const out = stripShellSource(input, true);
      expect(out.split("\n")[0]).toBe("echo '            ");
      expect(out.split("\n")[1]).toBe("x=12");
    });

    it("#689 round 18: a heredoc body's own # comment (at a word boundary) IS stripped now — the false green the real corpus reproduced", () => {
      // Round 16 shipped this exact input as "not a comment, just data": the whole heredoc body
      // passed through verbatim, so a symbol mentioned only in a comment *inside* a heredoc read
      // as a real occurrence. `deploy/install-launchd.sh:268` is exactly this shape for real —
      // `CODEX_HOME` appears nowhere else in that file — and the production CLI returned exit 0
      // with empty findings for it before this fix (see the real-corpus test below).
      const input = "cat <<'EOF'\n# a real comment now\nnot_a_comment#still_mid_word\nEOF\nx=13";
      const expected = "cat <<'EOF'\n\nnot_a_comment#still_mid_word\nEOF\nx=13";
      expect(stripShellSource(input, true)).toBe(expected);
      expect(stripShellSource(input, false)).toBe(expected); // comments are unconditional, not gated on blankStrings
    });

    it("#689 round 18: a quoted string inside a heredoc body is never blanked, in either view — a # inside it is not a comment", () => {
      // Narrower than treating the whole body as code of its content language: quoted-string
      // *content* inside a heredoc is left exactly as it was (unlike an ordinary quoted string
      // outside a heredoc, which the symbol view blanks) so a real occurrence reached through a
      // command substitution inside a double-quoted string — `required_keychain_value`'s own call
      // site in this same file's heredoc — is not erased along with genuine string prose.
      const input = 'cat <<\'EOF\'\necho "value #notacomment"\nEOF\nx=13b';
      expect(stripShellSource(input, true)).toBe(input);
      expect(stripShellSource(input, false)).toBe(input);
    });

    it("#689 round 18: the real deploy/install-launchd.sh — CODEX_HOME (only mentioned inside a heredoc's own # comment) is excluded from both views", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const text = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "install-launchd.sh"), "utf8");
      const count = (s: string) => (s.match(/CODEX_HOME/g) ?? []).length;
      expect(count(text)).toBe(1); // the file's only mention, deploy/install-launchd.sh:268
      expect(count(stripShellSource(text, true))).toBe(0);
      expect(count(stripShellSource(text, false))).toBe(0);
    });

    it("a <<- heredoc strips leading tabs only when matching the terminator line", () => {
      const input = "cat <<-'EOF'\n\tbody line\n\tEOF\nx=14";
      expect(stripShellSource(input, true)).toBe(input);
    });

    it("<<< (a here-string) is not mistaken for a heredoc", () => {
      const input = 'cat <<< "$var"\nx=15';
      expect(stripShellSource(input, true)).toBe('cat <<< "    "\nx=15');
    });

    it("an unterminated heredoc passes the rest of the file through verbatim", () => {
      const input = "cat <<'EOF'\nnever\nterminates";
      expect(stripShellSource(input, true)).toBe(input);
    });

    it("the real deploy/install-launchd.sh: required_keychain_value survives all three real occurrences", () => {
      // The concrete counterexample round 16 found: the old stripStrings(stripHashComments(text))
      // pipeline desynchronized every quote pairing after line 173's embedded #!/bin/bash, and
      // required_keychain_value (declared 191, called 249 and 250) survived none of them.
      const fs = require("node:fs");
      const path = require("node:path");
      const text = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "install-launchd.sh"), "utf8");
      const count = (s: string) => (s.match(/required_keychain_value/g) ?? []).length;
      expect(count(text)).toBe(3);
      expect(count(stripShellSource(text, true))).toBe(3);
      expect(count(stripShellSource(text, false))).toBe(3);
    });
  });

  describe("stripYamlSource (#689, round 16)", () => {
    it("# starts a comment at the start of a line", () => {
      expect(stripYamlSource("# comment\nkey: value", true)).toBe("\nkey: value");
    });

    it("# starts a comment after whitespace", () => {
      expect(stripYamlSource("key: value # trailing\nkey2: value2", true)).toBe("key: value \nkey2: value2");
    });

    it("# does NOT start a comment mid-word", () => {
      const input = "key: val#ue\nkey2: value2";
      expect(stripYamlSource(input, true)).toBe(input);
    });

    it("an apostrophe inside a # comment (an English contraction) does not open a string", () => {
      // The real shape in this repository's own .github/workflows/*.yml: "this job's id", "it's".
      const input = "# this job's id\nkey: value";
      expect(stripYamlSource(input, true)).toBe("\nkey: value");
    });

    it("a doubled '' inside a single-quoted scalar is a literal quote, not a terminator", () => {
      const input = "key: 'it''s here'\nkey2: value2";
      expect(stripYamlSource(input, true)).toBe("key: '          '\nkey2: value2");
    });

    it("a double-quoted scalar recognizes backslash escapes", () => {
      const input = 'key: "a\\"b"\nkey2: value2';
      expect(stripYamlSource(input, true)).toBe('key: "    "\nkey2: value2');
    });

    it("an unterminated single-quoted scalar whose tail is a doubled-escape at EOF is not miscounted as closed", () => {
      // Adversarial edge case: the span "'a''" ends in a quote character, but that trailing pair
      // is an escaped literal quote, not a real terminator — the string never actually closes.
      const input = "key: 'a''";
      const out = stripYamlSource(input, true);
      expect(out).toBe("key: '   "); // no closing quote appended — genuinely unterminated
    });
  });

  describe("stripSqlSource (#689, round 17 — the fifth and last dispatch)", () => {
    // Every delimiter-ordering shape this class of bug can take, for SQL's own delimiter set —
    // `--` and `/* */` comments, `'...'` value strings, `"..."`/`` ` ``/`[...]` identifier
    // quoting — each its own row, the same discipline every prior round used.

    it("-- starts a comment unconditionally — SQL has no word-boundary rule, unlike shell's #", () => {
      const input = "SELECT 1;--no space before this\nx=2";
      expect(stripSqlSource(input, true)).toBe("SELECT 1;\nx=2");
    });

    it("/* */ does not nest — confirmed against SQLite's own documented behavior", () => {
      const input = "/* outer /* inner */ still-code */\nx=4";
      // The first */ ends the comment; "still-code */" is left as ordinary (uncommented) text.
      expect(stripSqlSource(input, true)).toBe("                     still-code */\nx=4");
    });

    it("-- inside a '...' string is not read as a comment marker", () => {
      const input = "SELECT 'a--b';\nx=5";
      expect(stripSqlSource(input, true)).toBe("SELECT '    ';\nx=5");
      expect(stripSqlSource(input, false)).toBe(input);
    });

    it("/* */ inside a '...' string is not read as a comment", () => {
      const input = "SELECT 'a/*b*/c';\nx=6";
      expect(stripSqlSource(input, true)).toBe("SELECT '       ';\nx=6");
    });

    it("a quote inside a -- comment does not open a string", () => {
      const input = "-- this isn't \"real\" code\nx=7";
      expect(stripSqlSource(input, true)).toBe("\nx=7");
    });

    it("a quote inside a /* */ comment does not open a string", () => {
      const input = "/* say 'hi' and \"bye\" */\nx=8";
      expect(stripSqlSource(input, true)).toBe("                        \nx=8");
    });

    it("'' doubles as the escaped literal quote in a value string, not backslash", () => {
      const input = "SELECT 'it''s here';\nx=9";
      expect(stripSqlSource(input, true)).toBe("SELECT '          ';\nx=9");
    });

    it("backslash is a literal character inside a SQL string, not an escape", () => {
      // Confirmed against the real engine (better-sqlite3): a backslash does not escape a quote.
      const input = "SELECT 'a\\\\';\nx=10"; // interior is the 3 literal chars a, \, \
      expect(stripSqlSource(input, true)).toBe("SELECT '   ';\nx=10");
    });

    it('a "..." quoted identifier is never blanked — it is a name, not a value', () => {
      const input = 'SELECT "col""name" FROM t;\nx=11';
      expect(stripSqlSource(input, true)).toBe(input);
      expect(stripSqlSource(input, false)).toBe(input);
    });

    it("a `...` quoted identifier is never blanked — it is a name, not a value", () => {
      const input = "SELECT `col``name` FROM t;\nx=12";
      expect(stripSqlSource(input, true)).toBe(input);
    });

    it("a [...] quoted identifier is never blanked — it is a name, not a value", () => {
      const input = "SELECT [col name] FROM t;\nx=13";
      expect(stripSqlSource(input, true)).toBe(input);
    });

    it("a '...' string containing embedded double quotes (JSON) is one atomic span, not a nested string", () => {
      const input = "SELECT '{\"pending\":true}';\nx=14";
      expect(stripSqlSource(input, true)).toBe('SELECT \'                \';\nx=14');
    });

    it("an unterminated string is blanked to end of file — a raw newline does not end a SQL string", () => {
      // Unlike JS/shell, a real SQL string literal can legitimately contain a raw newline
      // (confirmed against better-sqlite3 directly), so an unterminated one is not cut off at the
      // first line break — it consumes to true end of input, the same disclosed answer
      // `stripJsSource`/`stripShellSource` give an unterminated template literal/heredoc.
      const input = "SELECT 'never closes\nx=15";
      const out = stripSqlSource(input, true);
      expect(out).toBe("SELECT '            \n    ");
    });

    it("dollar-quoting is not implemented — disclosed, not silently scored (no corpus, no engine support)", () => {
      // This repository's SQLite schema has no dollar-quoted string, and SQLite itself does not
      // support the PostgreSQL feature — a $ is just an ordinary character here.
      const input = "SELECT $tag$ raw text $tag$;\nx=16";
      expect(stripSqlSource(input, true)).toBe(input);
    });

    it("the real src/db/schema.sql and tests/fixtures/schema-v11.sql: old and new pipelines agree, both views", () => {
      // Measured, not assumed: this repository's tracked SQL has no `--`/`/* */` literally inside
      // a '...' string (verified with a proper quote-aware walk, not a naive regex — see this
      // function's own comment for why a naive one falsely finds several), so the cascading-desync
      // shape round 16 found in deploy/install-launchd.sh has no live instance here. The fix still
      // matters (a constructed instance below proves the old pipeline was just as blind), but this
      // asserts the honest fact about this corpus: no observable regression, no observable fix.
      const fs = require("node:fs");
      const path = require("node:path");
      const schemaPath = path.join(__dirname, "..", "..", "src", "db", "schema.sql");
      const fixturePath = path.join(__dirname, "..", "fixtures", "schema-v11.sql");
      for (const p of [schemaPath, fixturePath]) {
        const text = fs.readFileSync(p, "utf8");
        const oldSym = stripStrings(stripSqlComments(text));
        const newSym = stripSqlSource(text, true);
        const oldContent = stripSqlComments(text);
        const newContent = stripSqlSource(text, false);
        expect(newSym).toBe(oldSym);
        expect(newContent).toBe(oldContent);
      }
    });

    it("a constructed instance of the cascading defect: a symbol only inside a string with an embedded -- reads STALE only after the fix", () => {
      // The real corpus has no live instance of this (see the test above), so this constructs the
      // same shape round 16 found for real in deploy/install-launchd.sh: a -- embedded in a
      // '...' string destroys that string's closing quote under the old pipeline, and
      // stripStrings' whole-file regex pairs the orphaned quote with the next ' in the file,
      // desynchronizing everything after it.
      const text = [
        "SELECT 'note: value--marker still a string' AS explanation;",
        "SELECT 'first' AS a;",
        "SELECT 'onlyInsideThisSqlString' AS b;",
        "CREATE TABLE real_table_marker (id INTEGER);",
      ].join("\n");
      const oldSym = stripStrings(stripSqlComments(text));
      const newSym = stripSqlSource(text, true);
      expect(oldSym).toContain("onlyInsideThisSqlString"); // the old bug, reproduced
      expect(newSym).not.toContain("onlyInsideThisSqlString"); // fixed: correctly blanked
      expect(newSym).toContain("real_table_marker"); // real code still resolves
    });
  });
});
