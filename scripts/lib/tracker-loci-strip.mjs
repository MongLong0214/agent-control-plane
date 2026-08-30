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
 */

/** Blanks every non-newline character in a matched span, for use as a `String.replace` callback. */
export const blankKeepingNewlines = (match) => match.replace(/[^\n]/g, " ");

/**
 * Removes `//` line comments and `/* ... *\/` block comments before a symbol search, so a symbol
 * mentioned only in prose about the code — a comment explaining what a mechanism used to do, or
 * warning about a related concept — does not count toward it. A comment mentioning a word is a
 * sentence about it, not code that holds it.
 *
 * `://` is protected explicitly so a URL inside a comment or string (`https://…`) is not itself
 * misread as the start of a line comment.
 */
export const stripSlashComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, blankKeepingNewlines)
    .split("\n")
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ""))
    .join("\n");

/** `#` line comments — Python, shell, and YAML, the three `#`-comment extensions this checks. */
export const stripHashComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/(?<!:)#.*$/, ""))
    .join("\n");

/** SQL's own comment forms: `--` to end of line, and the same `/* ... *\/` block form as JS. */
export const stripSqlComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, blankKeepingNewlines)
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

/**
 * Removes the contents of single- and double-quoted string literals (the opening and closing
 * quote characters are kept, so this does not fuse the tokens on either side together). `"utf8"`
 * as an encoding argument is not a citation's enforcing symbol resolving — it is a string that
 * happens to spell the same word, and without this a row pairing any file with any common string
 * constant used in it would pass. Applies across every language this check handles: Python, shell,
 * YAML, and SQL all use the same two quote characters for a string, and JS/TS's own `"`/`'`
 * strings are the same shape.
 *
 * A measured gap, not a guessed one: a regex literal with a quote inside a character class
 * (`` /(["\\])/g `` — this repository has one, in `cli-adapters.ts`) is not told apart from a real
 * string boundary, because this is a text pass and does not know a regex literal from division.
 * Found while verifying an earlier fix: it did not change the primary verdict for any cited file,
 * only widened the "it also appears in" diagnostic aside on an unrelated file to include a false
 * hit. That aside is disclosed as a heuristic for exactly this reason — a pointer to go look, not
 * a second verified fact.
 */
export const stripStrings = (text) =>
  text
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => `"${blankKeepingNewlines(m.slice(1, -1))}"`)
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => `'${blankKeepingNewlines(m.slice(1, -1))}'`);

/**
 * #700: `stripStrings` treats every `"` and `'` as an independent single-character delimiter,
 * which is wrong for Python — a triple-quoted string (`"""..."""` or `'''...'''`) is one
 * multi-character delimiter, not three single-quote pairs. Feeding a module docstring through
 * `stripStrings` reads its opening `"""` as an empty string (`""`) immediately followed by a
 * fresh opening `"`, and every quote after that is paired one position out of phase for the rest
 * of the file — confirmed directly against the one `.py` file this repository tracks
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
    if (ch === '"' || ch === "'") {
      const isTriple = text.slice(i, i + 3) === ch.repeat(3);
      const delim = isTriple ? ch.repeat(3) : ch;
      let j = i + delim.length;
      let closed = false;
      while (j < n) {
        if (text[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text.slice(j, j + delim.length) === delim) {
          j += delim.length;
          closed = true;
          break;
        }
        j++;
      }
      const span = text.slice(i, j);
      if (blankStrings) {
        const closeLen = closed ? delim.length : 0;
        const interior = span.slice(delim.length, span.length - closeLen);
        out += span.slice(0, delim.length) + blankKeepingNewlines(interior) + (closeLen ? span.slice(-closeLen) : "");
      } else {
        out += span;
      }
      i = j;
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
 * `stripPythonSource` already resolves `#` and quotes for Python: `//`, `/* ... *\/`, `"`, `'`,
 * and `` ` `` (template literals, including their `${…}` expressions — walked recursively, so a
 * nested string, comment, or template inside an expression is resolved the same way, and a `}`
 * that closes a string inside the expression does not end the expression early) are each
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
 * An unterminated string or template literal (no closing delimiter before end of line/file, the
 * same adversarial shape the property test below exercises) is blanked up to wherever it actually
 * ends, rather than left completely unrecognized the way the old regex-based `stripStrings`
 * silently did — a defined, testable answer instead of an accidental one.
 */
export const stripJsSource = (text, blankStrings) => {
  const n = text.length;

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
