/**
 * The comment/string-stripping half of `verify-tracker-loci-resolve.mjs`'s `readCode` — split out
 * so a test can hold it to the one property that matters and that round 11 found violated: every
 * one of these has to preserve the input's line count, because `readCode`'s output is sliced by
 * line number (the content-search window) as well as searched as a whole (the symbol search), and
 * a stripper that collapses a multi-line span desynchronizes every line number after it from the
 * real file it claims to describe.
 *
 * Round 11: `stripSlashComments`/`stripSqlComments`/`stripStrings` used to replace a whole matched
 * span — a block comment or a quoted string, either of which can legitimately span several lines —
 * with one fixed short string (`" "`, `'""'`, `"''"`). That collapsed every internal newline the
 * match contained, shifting every line *after* the match one-for-one out of sync with the real
 * file — invisible for as long as `readCode`'s only consumer (`symbolPattern.test`) never asked
 * "which line", only "does this appear anywhere". It stopped being invisible the moment a second
 * consumer *did* ask which line: the content-search window slices `readCode`'s output by the cited
 * line number, and a multi-line `/** ... *\/` docstring ahead of the cited line silently moved
 * every line after it, making the window look at the wrong span of the file entirely — found
 * against the real corpus (issue #630, `src/runtime/hermes-ceo.ts`), not a constructed case.
 * `blankKeepingNewlines` is the fix: every stripper below now blanks non-newline characters in
 * place rather than replacing a span with a shorter string, so a match still cannot fuse the
 * tokens on either side of it (there is exactly as much blank space as there was match) and every
 * line number downstream of it still means the same real line it always did.
 *
 * Lives in its own file so a test can run it directly, the same reason
 * `collapse-trailer-paragraphs.mjs` does — inside the main script, this transform's only proof was
 * whatever citation the corpus happened to exercise, which is exactly how round 11's bug survived
 * nine rounds unnoticed.
 *
 * Its adjacent `.d.mts` is generated from the JSDoc in this file by `pnpm
 * declarations:tracker-loci-strip`; do not edit that declaration by hand. sol-simplify: this
 * generation step exists because TypeScript tests import a directly runnable `.mjs`; remove it if
 * the module moves to TypeScript or no TypeScript consumer imports it.
 */

import ts from "typescript";

/**
 * Blanks every non-newline character in a matched span, for use as a `String.replace` callback.
 *
 * @param {string} match
 * @returns {string}
 */
export const blankKeepingNewlines = (match) => match.replace(/[^\n]/g, " ");

/**
 * @typedef {object} StringBoundaryRule
 * @property {string} form
 * @property {string} open
 * @property {string} close
 * @property {"any" | readonly string[]} backslashEscapes
 * @property {boolean} [doubledCloseEscapes]
 * @property {boolean} rawNewlineEndsSpan
 */

/**
 * Quote boundaries for the three dispatches whose review counterexamples depend on delimiter
 * width, escape syntax, and raw-newline behavior. Longest openers come first so Python's triple
 * quotes and Bash's `$'` are each one token, never a sequence of shorter quote tokens.
 *
 * `backslashEscapes` names exactly which following characters cannot act as syntax: `"any"` for
 * Python and Bash ANSI-C quotes, an empty list for Bash single quotes, and Bash's five special
 * double-quote characters for Bash double quotes. `doubledCloseEscapes` records YAML's `''`
 * escape, which is neither a backslash escape nor two boundaries. `rawNewlineEndsSpan` says
 * whether an unescaped newline ends an unterminated quoted span: Python's short strings do;
 * Python triple strings, all three Bash quote forms, and both YAML quoted scalar forms do not.
 * Python's `f`/`r` prefixes sit before these delimiters and do not change their boundary rules;
 * f-string replacement fields remain part of the blanked span.
 *
 * YAML plain scalars do not have a quote delimiter at all, so `stripYamlSource` selects the two
 * rules in `yaml` only at a YAML value start. Its indentation-delimited block scalars are handled
 * by the same walk before quote matching.
 *
 * @type {Readonly<{python: readonly StringBoundaryRule[], shell: readonly StringBoundaryRule[], yaml: readonly StringBoundaryRule[]}>}
 */
export const STRING_BOUNDARY_RULES = Object.freeze({
  python: Object.freeze([
    {
      form: "triple double quote",
      open: '"""',
      close: '"""',
      backslashEscapes: /** @type {const} */ ("any"),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: false,
    },
    {
      form: "triple single quote",
      open: "'''",
      close: "'''",
      backslashEscapes: /** @type {const} */ ("any"),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: false,
    },
    {
      form: "short double quote",
      open: '"',
      close: '"',
      backslashEscapes: /** @type {const} */ ("any"),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: true,
    },
    {
      form: "short single quote",
      open: "'",
      close: "'",
      backslashEscapes: /** @type {const} */ ("any"),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: true,
    },
  ]),
  shell: Object.freeze([
    {
      form: "ANSI C quote",
      open: "$'",
      close: "'",
      backslashEscapes: /** @type {const} */ ("any"),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: false,
    },
    {
      form: "single quote",
      open: "'",
      close: "'",
      backslashEscapes: Object.freeze([]),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: false,
    },
    {
      form: "double quote",
      open: '"',
      close: '"',
      backslashEscapes: Object.freeze(["$", "`", '"', "\\", "\n"]),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: false,
    },
  ]),
  yaml: Object.freeze([
    {
      form: "single-quoted scalar",
      open: "'",
      close: "'",
      backslashEscapes: Object.freeze([]),
      doubledCloseEscapes: true,
      rawNewlineEndsSpan: false,
    },
    {
      form: "double-quoted scalar",
      open: '"',
      close: '"',
      backslashEscapes: /** @type {const} */ ("any"),
      doubledCloseEscapes: false,
      rawNewlineEndsSpan: false,
    },
  ]),
});

const backslashEscapesNext = (text, index, rule) =>
  text[index] === "\\" &&
  index + 1 < text.length &&
  (rule.backslashEscapes === "any" || rule.backslashEscapes.includes(text[index + 1]));

/** Returns the matching quote rule and its exact span, or null when no rule opens at `start`. */
const readQuotedSpan = (text, start, rules) => {
  const rule = rules.find(({ open }) => text.startsWith(open, start));
  if (!rule) return null;

  let end = start + rule.open.length;
  while (end < text.length) {
    if (backslashEscapesNext(text, end, rule)) {
      end += 2;
      continue;
    }
    if (rule.doubledCloseEscapes && text.startsWith(rule.close + rule.close, end)) {
      end += rule.close.length * 2;
      continue;
    }
    if (text.startsWith(rule.close, end)) {
      return { rule, end: end + rule.close.length, closed: true };
    }
    if (rule.rawNewlineEndsSpan && (text[end] === "\n" || text[end] === "\r")) {
      return { rule, end, closed: false };
    }
    end++;
  }
  return { rule, end, closed: false };
};

/** Blanks one already-recognized quoted span while preserving its delimiters and every newline. */
const renderQuotedSpan = (span, rule, closed, blankStrings) => {
  if (!blankStrings) return span;
  const closeLength = closed ? rule.close.length : 0;
  const interior = span.slice(rule.open.length, span.length - closeLength);
  return (
    span.slice(0, rule.open.length) +
    blankKeepingNewlines(interior) +
    (closeLength ? span.slice(-closeLength) : "")
  );
};

const isShellWordBoundaryBefore = (text, index) =>
  index === 0 || [" ", "\t", "\n", ";", "|", "&", "(", ")"].includes(text[index - 1]);

/** Finds the `)` paired with a Bash `$(`, ignoring parentheses inside nested quoted spans. */
const readShellCommandSubstitution = (text, start) => {
  let depth = 1;
  let end = start + 2;
  while (end < text.length) {
    if (text[end] === "\\" && end + 1 < text.length) {
      end += 2;
      continue;
    }
    const quoted = readShellQuotedSpan(text, end);
    if (quoted) {
      end = quoted.end;
      continue;
    }
    if (text[end] === "#" && isShellWordBoundaryBefore(text, end)) {
      while (end < text.length && text[end] !== "\n") end++;
      continue;
    }
    if (text.startsWith("$(", end)) {
      depth++;
      end += 2;
      continue;
    }
    if (text[end] === "(") {
      depth++;
      end++;
      continue;
    }
    if (text[end] === ")") {
      depth--;
      end++;
      if (depth === 0) return { end, closed: true };
      continue;
    }
    end++;
  }
  return { end, closed: false };
};

/**
 * Applies the shell rule table while letting a balanced `$()` body carry its own nested quotes.
 * Without this, an inner `"` would be mistaken for the close of the surrounding double quote.
 */
const readShellQuotedSpan = (text, start) => {
  const rule = STRING_BOUNDARY_RULES.shell.find(({ open }) => text.startsWith(open, start));
  if (!rule) return null;

  let end = start + rule.open.length;
  while (end < text.length) {
    if (backslashEscapesNext(text, end, rule)) {
      end += 2;
      continue;
    }
    if (rule.form === "double quote" && text.startsWith("$(", end)) {
      const command = readShellCommandSubstitution(text, end);
      end = command.end;
      if (!command.closed) return { rule, end, closed: false };
      continue;
    }
    if (text.startsWith(rule.close, end)) {
      return { rule, end: end + rule.close.length, closed: true };
    }
    if (rule.rawNewlineEndsSpan && (text[end] === "\n" || text[end] === "\r")) {
      return { rule, end, closed: false };
    }
    end++;
  }
  return { rule, end, closed: false };
};

/** Blanks shell string prose but recursively retains code inside balanced `$()` substitutions. */
const renderShellQuotedSpan = (span, rule, closed, blankStrings) => {
  if (!blankStrings || rule.form !== "double quote") {
    return renderQuotedSpan(span, rule, closed, blankStrings);
  }

  const closeLength = closed ? rule.close.length : 0;
  const interiorEnd = span.length - closeLength;
  let out = span.slice(0, rule.open.length);
  let cursor = rule.open.length;
  let proseStart = cursor;
  while (cursor < interiorEnd) {
    if (backslashEscapesNext(span, cursor, rule)) {
      cursor += 2;
      continue;
    }
    if (!span.startsWith("$(", cursor)) {
      cursor++;
      continue;
    }
    const command = readShellCommandSubstitution(span, cursor);
    if (!command.closed || command.end > interiorEnd) break;
    out += blankKeepingNewlines(span.slice(proseStart, cursor));
    out += "$(" + stripShellSource(span.slice(cursor + 2, command.end - 1), true) + ")";
    cursor = command.end;
    proseStart = cursor;
  }
  out += blankKeepingNewlines(span.slice(proseStart, interiorEnd));
  if (closeLength) out += span.slice(-closeLength);
  return out;
};

/**
 * Removes `//` line comments and `/* ... *\/` block comments before a symbol search, so a symbol
 * mentioned only in prose about the code — a comment explaining what a mechanism used to do, or
 * warning about a related concept — does not count toward it. A comment mentioning a word is a
 * sentence about it, not code that holds it.
 *
 * `://` is protected explicitly so a URL inside a comment or string (`https://…`) is not itself
 * misread as the start of a line comment.
 *
 * @param {string} text
 * @returns {string}
 */
export const stripSlashComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, blankKeepingNewlines)
    .split("\n")
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ""))
    .join("\n");

/**
 * `#` line comments — Python, shell, and YAML, the three `#`-comment extensions this checks.
 *
 * @param {string} text
 * @returns {string}
 */
export const stripHashComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/(?<!:)#.*$/, ""))
    .join("\n");

/**
 * SQL's own comment forms: `--` to end of line, and the same `/* ... *\/` block form as JS.
 *
 * @param {string} text
 * @returns {string}
 */
export const stripSqlComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, blankKeepingNewlines)
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

/**
 * Removes quoted content using an explicit delimiter table, keeping the opening and closing
 * delimiters so tokens on either side cannot fuse. The default table is Python's: it includes
 * single-character quote forms plus both triple-quote forms, with the longer openers
 * considered first. Callers that need another language pass that language's own table instead of
 * pretending the same two regular expressions describe every language.
 *
 * This helper only resolves quote boundaries; it does not resolve comments. Production dispatches
 * still own the ordered comment/string walk so a comment marker inside a string, or a quote inside
 * a comment, cannot be interpreted out of order.
 *
 * @param {string} text
 * @param {readonly StringBoundaryRule[]} [rules=STRING_BOUNDARY_RULES.python]
 * @returns {string}
 */
export const stripStrings = (text, rules = STRING_BOUNDARY_RULES.python) => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const quoted = readQuotedSpan(text, i, rules);
    if (!quoted) {
      out += text[i];
      i++;
      continue;
    }
    const span = text.slice(i, quoted.end);
    out += renderQuotedSpan(span, quoted.rule, quoted.closed, true);
    i = quoted.end;
  }
  return out;
};

/**
 * #700: the old regex implementation of `stripStrings` treated every `"` and `'` as an independent
 * single-character delimiter, which is wrong for Python — a triple-quoted string (`"""..."""` or
 * `'''...'''`) is one multi-character delimiter, not three single-quote pairs. Feeding a module
 * docstring through that implementation read its opening `"""` as an empty string (`""`)
 * followed by a fresh opening `"`, and every quote after that was paired one position out of
 * phase for the rest of the file — confirmed directly against the one `.py` file this repository
 * tracks
 * (`deploy/egress/allowlist-proxy.py`): `ALLOWLIST_DIGEST`'s own declaration at line 77, well
 * after the module docstring, is blanked away in the corrupted view.
 *
 * This walks Python source once, character by character, so a `#` and a quote are each resolved
 * in the order a real tokenizer would see them — in particular, a `#` *inside* a string (of
 * either width) is never mistaken for a comment marker, which the previous two-pass pipeline
 * (`stripStrings(stripHashComments(text))`) got wrong too: `stripHashComments` ran first and
 * blind to string boundaries, so a `#` inside a docstring (this repository's own module docstring
 * has one — "built and proved for #419") silently truncated that line before the string walk ever
 * ran.
 *
 * `blankStrings` picks which of two different callers this serves, because they need opposite
 * answers about string *content* (see `verify-tracker-loci-resolve.mjs` round 14 for the full
 * argument, and #700's finding 2):
 *
 *   - `true` — the symbol-search view (`readCode`): string content is blanked (delimiters kept),
 *     same as `stripStrings`, so a symbol name that only happens to be spelled inside a string
 *     literal does not count as the file declaring it.
 *   - `false` — the content/snippet-comparison view: comments are stripped but string content is
 *     left untouched, so a citation quoting a line whose string literal no longer matches the
 *     real one still reads STALE, rather than every string being an unconditional wildcard.
 *
 * @param {string} text
 * @param {boolean} blankStrings
 * @returns {string}
 */
export const stripPythonSource = (text, blankStrings) => {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "#") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      out += blankKeepingNewlines(text.slice(i, j));
      i = j;
      continue;
    }
    const quoted = readQuotedSpan(text, i, STRING_BOUNDARY_RULES.python);
    if (quoted) {
      const span = text.slice(i, quoted.end);
      out += renderQuotedSpan(span, quoted.rule, quoted.closed, blankStrings);
      i = quoted.end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
};

/**
 * #689 (round 15): the JS/TS pipeline — `stripStrings(stripTemplateLiteralProse(
 * stripSlashComments(text)))` for the symbol-search view, `stripSlashComments(text)` alone for the
 * content view — ran `stripSlashComments` *first*, blind to string and template-literal
 * boundaries. That is the exact defect #700 fixed for Python's `#` (see `stripPythonSource`'s own
 * comment), applied here to `//`: a `//` inside a string literal that contains no `://` (the one
 * shape `stripSlashComments`'s lookbehind protects) reads as a real comment and truncates the
 * line, destroying the string's closing quote before `stripStrings` ever runs.
 *
 * Confirmed against the real corpus, not a constructed case: `tests/integration/pipeline.test.ts`
 * writes `"module.exports = () => 2; // addressed review\n"` as a string; `module.exports`
 * appears *only* inside that string, and this script's own contract says a symbol found only
 * inside a string is STALE. Feeding it `` `module.exports` in
 * `tests/integration/pipeline.test.ts` `` returned `stale: []` instead — the corrupted
 * comment-strip deleted from the embedded `//` to end of line (there is no `:` right before it),
 * taking the string's closing quote with it. `stripStrings` then found no matching close on that
 * line and left `module.exports = () => 2; ` completely unrecognized as a string, so its content
 * was never blanked and the bare word read as if it were real code.
 *
 * `stripJsSource` replaces that three-function pipeline with one ordered character walk, the way
 * `stripPythonSource` already resolves `#` and quotes for Python: a leading hashbang, `//`,
 * `/* ... *\/`, `"`, `'`, regex literals, and `` ` `` (template literals, including their `${…}`
 * expressions — walked recursively, so a nested string, comment, regex, or template inside an
 * expression is resolved the same way, and a `}` inside one of those spans does not end the
 * expression early) are each
 * recognized in the order a real tokenizer would see them. A string or template literal is
 * entered — and everything inside it treated as literal content, never markup — the instant its
 * opening delimiter is seen, before any `//` or `/*` inside it gets a chance to be misread as a
 * comment. The mirror case holds symmetrically: once a `//` or `/* *\/` comment has started, a
 * `"`, `'`, or `` ` `` inside it is just comment text and never opens a string. With ordering
 * fixed at the source, the `://` lookbehind `stripSlashComments` needed is no longer necessary
 * here — a URL inside a string is protected because the string is recognized as one delimiter
 * before its interior `//` is ever inspected, not because of a special case for `:`.
 *
 * `blankStrings` answers the same question `stripPythonSource`'s does: `true` for the
 * symbol-search view (string and template-literal *content* blanked, delimiters kept — a symbol
 * only spelled inside a string does not count as the file declaring it); `false` for the
 * content-search view (comments blanked, string/template content left untouched, so a citation
 * quoting a string's exact text still compares against the real one).
 *
 * Round 21 adds the missing regex token. JavaScript's lexical goal for `/` depends on the preceding
 * significant token and its grammar context: the same block close can finish a declaration (a
 * regex may start the next statement) or an expression (the slash divides that value). A local
 * keyword/brace heuristic reproduced the review's case but failed valid function expressions,
 * class expressions, and contextual identifiers such as `of`. The existing TypeScript parser now
 * supplies the exact starts of regex-literal nodes; every other slash is division or an operator.
 * The ordered walk still owns rendering the regex as one span: escapes and character classes are
 * consumed before an unescaped `/` can close it, so quotes and comment markers inside the pattern
 * are ordinary bytes, and flags are blanked with the literal in the symbol view.
 *
 * JSX parsing is not selected because `stripJsSource` has no filename and this tracked corpus has
 * no `.jsx` or `.tsx` file. Grammar-invalid or proposal-only syntax follows TypeScript's recovery,
 * which can classify a slash differently from the author's intent; the CLI's per-language scope
 * names that cost. The production-CLI corpus test checks a real parser-derived declaration witness
 * in every tracked JS-family file, while the invariant test independently checks every parsed regex
 * literal and division token present in those files.
 *
 * An unterminated string, regex, or template literal (no closing delimiter before end of line/file,
 * the same adversarial shape the property test below exercises) is blanked up to wherever it
 * actually ends, rather than left completely unrecognized the way the old regex-based
 * `stripStrings` silently did — a defined, testable answer instead of an accidental one.
 *
 * @param {string} text
 * @param {boolean} blankStrings
 * @returns {string}
 */
export const stripJsSource = (text, blankStrings) => {
  const n = text.length;
  const parsed = ts.createSourceFile("tracker-loci.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const regexStarts = new Set();
  const collectRegexStarts = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) regexStarts.add(node.getStart(parsed));
    ts.forEachChild(node, collectRegexStarts);
  };
  collectRegexStarts(parsed);
  const isIdentifierPart = (ch) => ch !== undefined && /[$\u200c\u200d\p{ID_Continue}]/u.test(ch);

  /** Consumes a `"`/`'`-quoted string starting at `i`; returns the rendered span and next index. */
  const scanQuotedString = (i, quote) => {
    const start = i;
    let j = i + 1;
    while (j < n) {
      if (text[j] === "\\" && j + 1 < n) {
        j += 2;
        continue;
      }
      if (text[j] === quote) {
        j++;
        break;
      }
      if (text[j] === "\n") break; // a JS string does not span a raw newline
      j++;
    }
    const span = text.slice(start, j);
    if (!blankStrings) return { rendered: span, next: j };
    const closed = span.length > 1 && span[span.length - 1] === quote;
    const closeLen = closed ? 1 : 0;
    const interior = span.slice(1, span.length - closeLen);
    const rendered = span.slice(0, 1) + blankKeepingNewlines(interior) + (closeLen ? span.slice(-1) : "");
    return { rendered, next: j };
  };

  /**
   * Consumes a regex literal after `walk` has established that `/` begins an expression rather
   * than dividing the value before it. A slash inside `[...]` or after `\` is pattern content;
   * only an unescaped slash outside a character class closes the literal. A raw newline ends an
   * invalid/unterminated literal so one bad line cannot erase the next one.
   */
  const scanRegexLiteral = (i) => {
    const start = i;
    let j = i + 1;
    let inClass = false;
    let close = -1;
    while (j < n) {
      if (text[j] === "\n" || text[j] === "\r") break;
      if (text[j] === "\\") {
        if (text[j + 1] === "\n" || text[j + 1] === "\r") {
          j++;
          break;
        }
        j += Math.min(2, n - j);
        continue;
      }
      if (text[j] === "[") {
        inClass = true;
        j++;
        continue;
      }
      if (text[j] === "]" && inClass) {
        inClass = false;
        j++;
        continue;
      }
      if (text[j] === "/" && !inClass) {
        close = j;
        j++;
        while (j < n && isIdentifierPart(text[j])) j++;
        break;
      }
      j++;
    }

    const span = text.slice(start, j);
    if (!blankStrings) return { rendered: span, next: j };
    if (close === -1) {
      return { rendered: "/" + blankKeepingNewlines(text.slice(start + 1, j)), next: j };
    }
    const pattern = text.slice(start + 1, close);
    const flags = text.slice(close + 1, j);
    return {
      rendered: "/" + blankKeepingNewlines(pattern) + "/" + blankKeepingNewlines(flags),
      next: j,
    };
  };

  /**
   * Consumes a template literal starting at `i` (`text[i] === "`"`). Prose is blanked (in
   * `blankStrings` mode) the same way `stripTemplateLiteralProse` blanks it; a `${…}` expression
   * is handed to `walk` in expression mode so its own strings/comments/nested templates resolve
   * through the same ordered logic, and a brace inside one of those does not miscount toward the
   * expression's own close.
   */
  const scanTemplateLiteral = (i) => {
    let out = "`";
    i++;
    let proseStart = i;
    const flushProse = (end) => {
      const prose = text.slice(proseStart, end);
      out += blankStrings ? blankKeepingNewlines(prose) : prose;
    };
    while (i < n) {
      if (text[i] === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (text[i] === "`") {
        flushProse(i);
        out += "`";
        return { rendered: out, next: i + 1 };
      }
      if (text[i] === "$" && text[i + 1] === "{") {
        flushProse(i);
        out += "${";
        const { rendered, next } = walk(i + 2, 1);
        out += rendered;
        i = next;
        proseStart = i;
        continue;
      }
      i++;
    }
    flushProse(i); // unterminated template literal: flush whatever prose remains to end of text
    return { rendered: out, next: i };
  };

  /**
   * The shared ordered walk. `exprDepth === null` means top-level (runs to end of text);
   * otherwise it is inside a template literal's `${…}` and returns the moment a `}` brings the
   * (already-1-deep, for the `${` that opened it) depth back to 0 — a literal `{`/`}` reached
   * as ordinary code (not inside a string/comment/nested template, which are each consumed whole
   * by their own branch below and never seen by this counter) adjusts that depth first.
   */
  const walk = (start, exprDepth) => {
    let out = "";
    let depth = exprDepth ?? null;
    let i = start;

    while (i < n) {
      const ch = text[i];
      if ((i === 0 || (i === 1 && text[0] === "\ufeff")) && ch === "#" && text[i + 1] === "!") {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
        continue; // line comments are deleted outright, matching stripSlashComments
      }
      if (ch === "/" && text[i + 1] === "*") {
        const blockStart = i;
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
        if (i < n) i += 2;
        out += blankKeepingNewlines(text.slice(blockStart, i));
        continue;
      }
      if (ch === "/" && regexStarts.has(i)) {
        const { rendered, next } = scanRegexLiteral(i);
        out += rendered;
        i = next;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const { rendered, next } = scanQuotedString(i, ch);
        out += rendered;
        i = next;
        continue;
      }
      if (ch === "`") {
        const { rendered, next } = scanTemplateLiteral(i);
        out += rendered;
        i = next;
        continue;
      }
      if (depth !== null && ch === "{") {
        depth++;
        out += ch;
        i++;
        continue;
      }
      if (depth !== null && ch === "}") {
        depth--;
        out += ch;
        i++;
        if (depth === 0) return { rendered: out, next: i };
        continue;
      }
      out += ch;
      i++;
    }
    return { rendered: out, next: i };
  };

  return walk(0, null).rendered;
};

/**
 * Template literals (`` `...` ``) hold two different things at once: literal text the author
 * wrote, and `${…}` expressions that are ordinary code. Stripping the whole literal (the earlier
 * approach) throws the code away with the prose; leaving it alone (the approach before that) reads
 * `` `session lifecycle ${a} -> ${b} is not legal` `` as *containing* the symbol `legal`, when
 * `legal` is prose the author wrote, not a reference to anything.
 *
 * So a template literal is walked, not stripped: everything between backticks that is *not*
 * inside a `${…}` becomes blank space, and a `${…}` span — brace-balanced, so a nested object
 * literal inside the expression does not end it early — passes through untouched, to be searched
 * as the real code it is. A stray, unterminated backtick (this is a text pass, not a lexer, so one
 * can appear from a markdown code span or a mismatched edit elsewhere) stops the walk at end of
 * string rather than consuming the rest of the file as one giant "literal".
 *
 * @param {string} text
 * @returns {string}
 */
export const stripTemplateLiteralProse = (text) => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i];
      i++;
      continue;
    }
    out += "`";
    i++;
    while (i < text.length && text[i] !== "`") {
      if (text[i] === "\\" && i + 1 < text.length) {
        // The escaped character can itself be a newline — a template literal's line-continuation,
        // the same escape an ordinary string uses. Blanking it to two spaces unconditionally (an
        // earlier version of this branch did, on the theory that neither char is a symbol
        // reference) ate that newline along with it, shifting every line after it out of sync
        // with the real file — found by the property test this file exists for, the same class
        // of bug round 11 fixed for the block-comment and string strippers above.
        out += text[i + 1] === "\n" ? "\n" : "  ";
        i += 2;
        continue;
      }
      if (text[i] === "$" && text[i + 1] === "{") {
        let depth = 1;
        const start = i;
        i += 2;
        while (i < text.length && depth > 0) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") depth--;
          i++;
        }
        out += text.slice(start, i); // the ${...} expression, verbatim: this is real code
        continue;
      }
      out += text[i] === "\n" ? "\n" : " ";
      i++;
    }
    if (i < text.length) {
      out += "`";
      i++;
    }
  }
  return out;
};

/**
 * #689 round 16: the shell/YAML pipeline (`stripStrings(stripHashComments(text))` for the symbol
 * view, `stripHashComments(text)` alone for the content view) has the identical ordering defect
 * round 15 fixed for JS/TS — plus a `#` word-boundary rule neither pass ever implemented. Real
 * shell only treats `#` as a comment marker at the start of a word (preceded by whitespace, a
 * tab, a newline, or the start of the file); `echo foo#bar` is not a comment. The old
 * `(?<!:)#.*$` regex knew nothing about that — only about a `:` immediately before the `#`.
 *
 * Confirmed against the real corpus, not a constructed case: `deploy/install-launchd.sh:173`
 * writes `printf '#!/bin/bash\nset -euo pipefail\n'` — a single-quoted string whose content
 * starts with `#!/bin/bash`. The old `stripHashComments` ran first, blind to the string boundary;
 * the `#` right after the opening `'` (preceded by `'`, not `:`) started a "comment" that consumed
 * the rest of the line, including the string's own closing `'`. The old `stripStrings`
 * single-quote regex (`/'(?:[^'\\]|\\.)*'/g`, which spans newlines) then paired that surviving lone `'` with
 * the *next* `'` character anywhere later in the file — the opening quote of the following line's
 * own `printf '...'` — and every quote pairing after that was one quote out of phase for the rest
 * of the file. Confirmed directly: `required_keychain_value` (declared at line 191, called at 249
 * and 250 — three real, current occurrences) does not survive a single one of them in the old
 * stripped view; the old `stripStrings(stripHashComments(...))` pipeline contained zero matches
 * for a symbol this file genuinely, currently declares and calls.
 *
 * `stripShellSource` replaces that two-function pipeline with one ordered character walk, the
 * same shape `stripPythonSource`/`stripJsSource` already use:
 *
 *   - `#` starts a comment only at `i === 0` or when the previous character is a space, tab, or
 *     newline. Getting the *rule* right, rather than patching the one shape a corpus citation
 *     happened to expose, also fixes three shapes this same tracked file's real code already
 *     contains, confirmed by grep rather than assumed: `$#` (the positional-parameter-count
 *     variable, `while [[ $# -gt 0 ]]`), `##` (suffix-removal parameter expansion,
 *     `${metadata##* }`), and `8#` (arithmetic base notation, `8#$mode`) — none of these are
 *     comments, and none needed a dedicated branch once "preceded by whitespace" replaced
 *     "preceded by `:`" as the actual rule.
 *   - a plain single-quoted string (`'...'`) has *no* escape character at all — a backslash
 *     inside one is a literal backslash, not an escape, and the closing delimiter is the very next
 *     `'`, unconditionally. This differs from the default Python short-string rule (backslash
 *     escaped — only true for `$'...'` in shell) and from YAML's single-quoted scalar (a doubled
 *     `''` is a literal quote —
 *     see `stripYamlSource`).
 *   - `$'...'` (ANSI-C quoting) *does* recognize backslash escapes (`\n`, `\t`, `\'`, …), so it
 *     gets its own branch rather than falling into the plain single-quote one.
 *   - a double-quoted string (`"..."`) gives backslash special meaning only before `"`, `\\`,
 *     `` ` ``, `$`, and a newline. The rule table names those five cases explicitly instead of
 *     treating every `\X` pair like an escape.
 *   - a heredoc (`<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`) is recognized the moment it opens; a
 *     bare-word delimiter must start with a letter or underscore, which excludes an arithmetic
 *     left-shift (`$((1 << 2))`) from being misread as one — disclosed, not silently guessed,
 *     because this repository's own tracked `.sh` file has no numeric or otherwise-unusual
 *     heredoc word to test it against. `<<<` (a here-string, a single word/string argument, not a
 *     multi-line body) is excluded explicitly so it falls through to ordinary quote handling
 *     instead. The body — from the line after the opener to the line that is exactly the
 *     delimiter word (leading tabs stripped first when the operator was `<<-`) — is literal data
 *     or, as in this file's own two heredocs, an embedded second script. The body is therefore
 *     walked recursively in the caller's selected view: comments and ordinary string prose are
 *     excluded from a symbol search, while balanced `$()` bodies inside double quotes remain code.
 *     An unterminated heredoc passes the remainder through the same rule rather than guessing where
 *     it would have ended.
 *     Content on the heredoc-opening
 *     line *after* the operator (a trailing `# comment`, more of the command) is not treated as
 *     part of the body — it is walked normally, through this same dispatch, before the body
 *     consumption begins at the next newline — so a heredoc opened mid-pipeline is not mistaken
 *     for one whose body starts immediately.
 *
 * Disclosed, not silently scored: a *quoted* heredoc word containing anything other than letters,
 * digits, or underscore, and a delimiter word given with special characters, are not recognized —
 * neither shape appears in this repository's own tracked `.sh` file, confirmed by grep. Multiple
 * heredocs opened on one line (`cmd <<A <<B`) are queued and consumed in order, which this
 * repository's tracked file does not exercise either, but is handled rather than assumed away.
 *
 * @param {string} text
 * @param {boolean} blankStrings
 * @returns {string}
 */
export const stripShellSource = (text, blankStrings) => {
  const n = text.length;
  let out = "";
  let i = 0;
  const pendingHeredocs = [];

  // #689 round 18: a new shell word does not only start after whitespace — it also starts right
  // after a control operator that ends the previous word/command, even with no space between them.
  // `;# comment` and `|# comment` are both real comments (confirmed: neither this repository's own
  // `.sh` files nor `.github/workflows/*.yml` currently contain this shape, so this closes a latent
  // gap rather than one the corpus has already exercised — the earlier whitespace-only rule was
  // still wrong to have, per this same file's own "get the rule right" standard for `$#`/`##`/`8#`
  // just above). `;`, `|`, and `&` cover `;;`/`||`/`&&` too, since checking only the immediately
  // preceding character is enough regardless of how many of that character precede it; `(`/`)`
  // cover a subshell or function body opening/closing right before a `#`.
  /**
   * #689 round 18: a heredoc body is genuinely part of what the file contains, and this
   * repository's own two heredocs are embedded shell scripts (`deploy/install-launchd.sh:187-287`
   * is a full nested launcher, function definitions and all) — but "genuinely part of the file"
   * does not mean "not a comment". `deploy/install-launchd.sh:268` is a `#`-prefixed line inside
   * that heredoc, at a real word boundary (start of line), explaining a design decision; the
   * symbol `CODEX_HOME` appears *only* there, nowhere else in the file. Passing the body through
   * fully verbatim (the pre-#689-round-18 behavior) read that comment as code and returned a false
   * green — reproduced against the real production CLI: `` `CODEX_HOME` in
   * `deploy/install-launchd.sh` `` returned exit 0 with empty findings, when the file's only
   * mention of the symbol is prose about a bug, not a use of it.
   *
   * The body recurses with the caller's `blankStrings` choice. In symbol view that excludes its
   * comments and ordinary quoted prose, including the multiline `node -e '...'` program whose JS
   * comment contains `expect`; in content view it preserves strings. Balanced `$()` content inside
   * a double quote is recursively searched as code in symbol view, so the real
   * `"$(required_keychain_value …)"` call remains visible without treating all surrounding string
   * prose as code.
   */
  const consumeHeredocBody = ({ delim, stripTabs }) => {
    // `i` is already past the newline that starts the body.
    let cursor = i;
    while (cursor <= n) {
      const nextNl = text.indexOf("\n", cursor);
      const lineEnd = nextNl === -1 ? n : nextNl;
      const line = text.slice(cursor, lineEnd);
      const compare = stripTabs ? line.replace(/^\t+/, "") : line;
      if (compare === delim) {
        out += stripShellSource(text.slice(i, lineEnd), blankStrings); // body + delimiter line, same symbol/content view
        i = lineEnd;
        return;
      }
      if (nextNl === -1) {
        out += stripShellSource(text.slice(i, n), blankStrings); // unterminated: rest of file, same symbol/content view
        i = n;
        return;
      }
      cursor = nextNl + 1;
    }
  };

  while (i < n) {
    const ch = text[i];

    if (ch === "\n" && pendingHeredocs.length > 0) {
      out += "\n";
      i++;
      const queue = pendingHeredocs.splice(0);
      for (const heredoc of queue) consumeHeredocBody(heredoc);
      continue;
    }

    if (ch === "#" && isShellWordBoundaryBefore(text, i)) {
      while (i < n && text[i] !== "\n") i++;
      continue; // deleted outright, matching stripHashComments' existing behavior
    }

    const quoted = readShellQuotedSpan(text, i);
    if (quoted) {
      const span = text.slice(i, quoted.end);
      out += renderShellQuotedSpan(span, quoted.rule, quoted.closed, blankStrings);
      i = quoted.end;
      continue;
    }

    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const match = /^<<(-?)[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(
        text.slice(i, i + 256),
      );
      if (match) {
        pendingHeredocs.push({ delim: match[2] ?? match[3] ?? match[4], stripTabs: match[1] === "-" });
        out += match[0];
        i += match[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
};

/**
 * #689: YAML's comment and scalar boundaries in one ordered walk.
 *
 * A quote is a delimiter only when it is the first non-whitespace character at a value start.
 * Otherwise the value is a plain scalar and both `'` and `"` are ordinary content, so
 * `description: it's plain` cannot open a scalar that consumes the rest of the file. The quoted
 * forms use `STRING_BOUNDARY_RULES.yaml`: doubled `''` escapes a single quote, backslash escapes
 * inside a double-quoted scalar, and either form may span a raw newline.
 *
 * Literal (`|`) and folded (`>`) block scalar bodies end at their indentation boundary. Their
 * contents remain searchable as plain text because this checker does not know the embedded
 * language, but quote and `#` characters inside the body are data and cannot change the YAML
 * walk's state. Header comments are still stripped before the body is copied.
 *
 * @param {string} text
 * @param {boolean} blankStrings
 * @returns {string}
 */
export const stripYamlSource = (text, blankStrings) => {
  const n = text.length;
  let out = "";
  let i = 0;

  const isWordBoundaryBefore = (idx) =>
    idx === 0 || text[idx - 1] === " " || text[idx - 1] === "\t" || text[idx - 1] === "\n";

  const isValueStart = (idx) => {
    const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
    let previous = idx - 1;
    while (previous >= lineStart && (text[previous] === " " || text[previous] === "\t")) previous--;
    if (previous < lineStart) return false;
    if (text[previous] === ":" || text[previous] === "[" || text[previous] === "{" || text[previous] === ",") {
      return true;
    }
    return text[previous] === "-" && /^[ \t]*$/.test(text.slice(lineStart, previous));
  };

  const readBlockScalar = (start) => {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEndAt = text.indexOf("\n", start);
    const lineEnd = lineEndAt === -1 ? n : lineEndAt;
    const header = text.slice(start, lineEnd);
    const indicator = /^(?:[|>])(?:([1-9])([+-])?|([+-])([1-9])?)?/.exec(header);
    if (!indicator || !/^[ \t]*(?:#.*)?$/.test(header.slice(indicator[0].length))) return null;

    const baseIndent = (/^[ \t]*/.exec(text.slice(lineStart, start))?.[0].length ?? 0);
    const explicitIndent = indicator[1] ?? indicator[4];
    let contentIndent = explicitIndent ? baseIndent + Number(explicitIndent) : null;
    const bodyStart = lineEndAt === -1 ? n : lineEnd + 1;
    let cursor = bodyStart;

    while (cursor < n) {
      const nextLineEndAt = text.indexOf("\n", cursor);
      const nextLineEnd = nextLineEndAt === -1 ? n : nextLineEndAt;
      const line = text.slice(cursor, nextLineEnd).replace(/\r$/, "");
      if (!/^[ \t]*$/.test(line)) {
        const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
        if (contentIndent === null) {
          if (indent <= baseIndent) break;
          contentIndent = indent;
        }
        if (indent < contentIndent) break;
      }
      cursor = nextLineEndAt === -1 ? n : nextLineEnd + 1;
    }

    return { header, lineEndAt, bodyStart, end: cursor };
  };

  while (i < n) {
    const ch = text[i];

    if (ch === "#" && isWordBoundaryBefore(i)) {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    if ((ch === "|" || ch === ">") && isValueStart(i)) {
      const block = readBlockScalar(i);
      if (block) {
        const comment = block.header.indexOf("#");
        out += comment === -1 ? block.header : block.header.slice(0, comment);
        if (block.lineEndAt !== -1) out += "\n" + text.slice(block.bodyStart, block.end);
        i = block.end;
        continue;
      }
    }

    if ((ch === "'" || ch === '"') && isValueStart(i)) {
      const quoted = readQuotedSpan(text, i, STRING_BOUNDARY_RULES.yaml);
      if (quoted) {
        const span = text.slice(i, quoted.end);
        out += renderQuotedSpan(span, quoted.rule, quoted.closed, blankStrings);
        i = quoted.end;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
};

/**
 * #689 round 17: the fifth instance of the same defect, disclosed and left unfixed at the end of
 * round 16 and sent back for exactly that reason. SQL's dispatch
 * (formerly `stripStrings(stripSqlComments(text))` for the symbol view and
 * `stripSqlComments(text)` alone for the content view) had the identical two-pass,
 * comment-blind-to-strings shape round 15 fixed for JS/TS and round 16 fixed for shell/YAML.
 *
 * Measured against this repository's own tracked SQL, not assumed: neither `src/db/schema.sql`
 * nor `tests/fixtures/schema-v11.sql` contains a `--` or `/* *\/` literally inside a `'...'`
 * string (checked with a proper quote-aware walk, not a naive regex — a naive one falsely
 * "finds" several, all of them an English possessive apostrophe inside a `--` comment pairing
 * with a real string quote many lines later, the identical mirror-case trap round 16's own
 * corpus check for YAML ran into and had to walk past). So the cascading-desync shape round 16
 * found in `deploy/install-launchd.sh` has no live instance in this repository's SQL today — a
 * fact about this corpus, not a reason to leave the ordering defect itself unfixed, since the
 * pipeline is exactly as blind to string boundaries as the shell one was.
 *
 * `stripSqlSource` replaces that pipeline with one ordered walk, the same shape as the other four:
 *
 *   - `--` starts a line comment unconditionally — unlike shell's `#`, SQL's `--` has no other
 *     meaning outside a string/identifier, so there is no word-boundary rule to get right here.
 *   - `/* ... *\/` block comments do not nest — confirmed against SQLite's own documented
 *     behavior (this repository's actual engine, via `better-sqlite3`: "SQL comments... do not
 *     nest" — the first `*\/` ends the comment regardless of an intervening `/*`), matching what
 *     the existing (non-ordered) `stripSqlComments` already assumed.
 *   - a `'...'` value string literal escapes its own delimiter by *doubling* it (`''`), not with a
 *     backslash — standard SQL and SQLite both treat `\` as a literal character inside a string.
 *     This was a real correction from the old generic single-quote regex (which assumed
 *     backslash-escaping), not just a reordering; this repository's own corpus has no
 *     backslash-adjacent-to-quote case to have exposed the difference, confirmed by grep.
 *   - `"..."`, `` `...` ``, and `[...]` are *identifier* quoting, not value quoting — a quoted
 *     column or table name is a real reference the same way a bareword identifier is, so unlike a
 *     `'...'` string's content it is never blanked in either view; each is still recognized as its
 *     own atomic span so its content cannot desynchronize the comment/string walk around it (the
 *     same reason a template literal's prose gets walked rather than ignored in `stripJsSource`).
 *     `"..."`/`` `...` `` escape their own delimiter by doubling, the same convention as `'...'`;
 *     `[...]` has no escape convention in real SQL Server/Access either, so a literal `]` inside
 *     one cannot be represented and this does not try to guess one. None of the three appears as
 *     a real identifier anywhere in this repository's tracked SQL (only inside `--` comments, as
 *     Markdown code-spans referencing a column name in prose) — confirmed by grep, disclosed
 *     rather than assumed covered.
 *   - the mirror case holds the same way it does for every other language here: once a `--` or
 *     `/* *\/` comment has started, a `'`/`"`/`` ` ``/`[` inside it is just comment text and never
 *     opens a string or identifier.
 *
 * Disclosed, not silently scored, per explicit instruction rather than left implicit: dollar-
 * quoting (`$tag$...$tag$`, PostgreSQL's own arbitrary-delimiter string form) is not implemented —
 * this repository's SQLite schema has no dollar-quoted string anywhere (the four `$` characters
 * that do appear are all inside ordinary `'...'` strings, `json_extract`'s own `'$.path'`
 * argument syntax, not a quoting delimiter), and SQLite itself does not support the feature, so
 * there is nothing in this corpus or this engine to verify a dollar-quote implementation against.
 *
 * @param {string} text
 * @param {boolean} blankStrings
 * @returns {string}
 */
export const stripSqlSource = (text, blankStrings) => {
  const n = text.length;
  let out = "";
  let i = 0;

  /** Consumes an identifier quoted with a single repeated delimiter char, doubled to escape it. */
  const scanDoubledIdentifier = (delim) => {
    const start = i;
    let j = i + 1;
    while (j < n) {
      if (text[j] === delim && text[j + 1] === delim) {
        j += 2;
        continue;
      }
      if (text[j] === delim) {
        j++;
        break;
      }
      j++;
    }
    i = j;
    return text.slice(start, j); // verbatim, never blanked — a name, not a value
  };

  while (i < n) {
    const ch = text[i];

    if (ch === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue; // deleted outright, matching stripSqlComments' existing behavior
    }

    if (ch === "/" && text[i + 1] === "*") {
      // Non-nesting, matching SQLite's own documented behavior: the first */ ends it.
      const start = i;
      let j = i + 2;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
      if (j < n) j += 2;
      out += blankKeepingNewlines(text.slice(start, j));
      i = j;
      continue;
    }

    if (ch === "'") {
      const start = i;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text[j] === "'" && text[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      const span = text.slice(start, j);
      if (blankStrings) {
        const closeLen = closed ? 1 : 0;
        const interior = span.slice(1, span.length - closeLen);
        out += span.slice(0, 1) + blankKeepingNewlines(interior) + (closeLen ? "'" : "");
      } else {
        out += span;
      }
      i = j;
      continue;
    }

    if (ch === '"' || ch === "`") {
      out += scanDoubledIdentifier(ch);
      continue;
    }

    if (ch === "[") {
      const start = i;
      let j = i + 1;
      while (j < n && text[j] !== "]") j++;
      if (j < n) j++;
      out += text.slice(start, j); // verbatim, never blanked — a name, not a value
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
};
