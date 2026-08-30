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
 * the rest of the line, including the string's own closing `'`. `stripStrings`'s single-quote
 * regex (`/'(?:[^'\\]|\\.)*'/g`, which spans newlines) then paired that surviving lone `'` with
 * the *next* `'` character anywhere later in the file — the opening quote of the following line's
 * own `printf '...'` — and every quote pairing after that was one quote out of phase for the rest
 * of the file. Confirmed directly: `required_keychain_value` (declared at line 191, called at 249
 * and 250 — three real, current occurrences) does not survive a single one of them in the old
 * stripped view; `stripStrings(stripHashComments(readFileSync("deploy/install-launchd.sh")))`
 * contains zero matches for a symbol this file genuinely, currently declares and calls.
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
 *     `'`, unconditionally. This is a real difference from `stripStrings`'s generic single-quote
 *     regex (which treats every single-quoted string as backslash-escaped — only true for
 *     `$'...'`, below) and from YAML's single-quoted scalar (a doubled `''` is a literal quote —
 *     see `stripYamlSource`).
 *   - `$'...'` (ANSI-C quoting) *does* recognize backslash escapes (`\n`, `\t`, `\'`, …), so it
 *     gets its own branch rather than falling into the plain single-quote one.
 *   - a double-quoted string (`"..."`) recognizes backslash escapes — the same generic "any `\X`
 *     pair does not end the string" treatment `stripStrings`/`stripPythonSource`/`stripJsSource`
 *     already use. Real shell only makes `\"`, `\\`, `` \` ``, `\$`, and an escaped newline special
 *     inside double quotes; treating every `\X` pair as non-terminating is a safe superset for the
 *     one thing this function needs to get right — where the string actually ends.
 *   - a heredoc (`<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`) is recognized the moment it opens; a
 *     bare-word delimiter must start with a letter or underscore, which excludes an arithmetic
 *     left-shift (`$((1 << 2))`) from being misread as one — disclosed, not silently guessed,
 *     because this repository's own tracked `.sh` file has no numeric or otherwise-unusual
 *     heredoc word to test it against. `<<<` (a here-string, a single word/string argument, not a
 *     multi-line body) is excluded explicitly so it falls through to ordinary quote handling
 *     instead. The body — from the line after the opener to the line that is exactly the
 *     delimiter word (leading tabs stripped first when the operator was `<<-`) — passes through
 *     untouched: not comment-stripped, not string-scanned, not blanked, because it is not a string
 *     literal or a comment, it is literal data (or, as in this file's own two heredocs, an embedded
 *     second script) that is genuinely part of what the file contains. An unterminated heredoc (no
 *     matching delimiter line before end of file) passes the remainder of the file through the
 *     same way, rather than guessing where it would have ended. Content on the heredoc-opening
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
 */
export const stripShellSource = (text, blankStrings) => {
  const n = text.length;
  let out = "";
  let i = 0;
  const pendingHeredocs = [];

  const isWordBoundaryBefore = (idx) =>
    idx === 0 || text[idx - 1] === " " || text[idx - 1] === "\t" || text[idx - 1] === "\n";

  /**
   * Renders a quoted span, honoring `blankStrings` the same way every other stripper here does.
   * `openLen`/`closeLen` are given independently — `$'...'` opens with 2 characters (`$'`) and
   * closes with 1 (`'`), which a single shared width would get wrong for one side or the other.
   * `closed` says whether `span`'s last `closeLen` characters really are the closing delimiter
   * (false for an unterminated string, where the whole remainder after the opener is interior).
   */
  const renderQuoted = (span, openLen, closeLen, closed) => {
    if (!blankStrings) return span;
    const actualCloseLen = closed ? closeLen : 0;
    const interior = span.slice(openLen, span.length - actualCloseLen);
    return (
      span.slice(0, openLen) + blankKeepingNewlines(interior) + (actualCloseLen ? span.slice(-actualCloseLen) : "")
    );
  };

  const consumeHeredocBody = ({ delim, stripTabs }) => {
    // `i` is already past the newline that starts the body.
    let cursor = i;
    while (cursor <= n) {
      const nextNl = text.indexOf("\n", cursor);
      const lineEnd = nextNl === -1 ? n : nextNl;
      const line = text.slice(cursor, lineEnd);
      const compare = stripTabs ? line.replace(/^\t+/, "") : line;
      if (compare === delim) {
        out += text.slice(i, lineEnd); // body + delimiter line, verbatim
        i = lineEnd;
        return;
      }
      if (nextNl === -1) {
        out += text.slice(i, n); // unterminated: rest of file is body, verbatim
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

    if (ch === "#" && isWordBoundaryBefore(i)) {
      while (i < n && text[i] !== "\n") i++;
      continue; // deleted outright, matching stripHashComments' existing behavior
    }

    if (ch === "$" && text[i + 1] === "'") {
      const start = i;
      let j = i + 2;
      let closed = false;
      while (j < n) {
        if (text[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          j++;
          closed = true;
          break;
        }
        if (text[j] === "\n") break;
        j++;
      }
      out += renderQuoted(text.slice(start, j), 2, 1, closed); // opens "$'" (2), closes "'" (1)
      i = j;
      continue;
    }

    if (ch === "'") {
      const start = i;
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== "\n") j++;
      const closed = j < n && text[j] === "'";
      if (closed) j++;
      out += renderQuoted(text.slice(start, j), 1, 1, closed);
      i = j;
      continue;
    }

    if (ch === '"') {
      const start = i;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          closed = true;
          break;
        }
        if (text[j] === "\n") break;
        j++;
      }
      out += renderQuoted(text.slice(start, j), 1, 1, closed);
      i = j;
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
 * #689 round 16: YAML's own comment/quote rules, in the same one-ordered-walk shape. YAML shares
 * shell's `#`-word-boundary rule (a `#` only starts a comment preceded by whitespace or at the
 * start of a line — confirmed against this repository's own tracked `.github/workflows/*.yml`:
 * every apostrophe inside an English contraction in a comment, `` job's ``/`` it's ``/`` PR's ``,
 * sits *after* a `#` that already opened the comment at a word boundary, so it is never reached as
 * a potential quote-opener — the same mirror case round 15 named for JS's `//`), but its quoting
 * rules differ from both shell and JS:
 *
 *   - a single-quoted scalar (`'...'`) escapes a literal quote by *doubling* it (`''`), not with a
 *     backslash — a backslash inside one is a literal backslash. Different from shell's plain
 *     single-quote (no escape of any kind) and from `stripStrings`'s generic regex (backslash-
 *     escaped, which is right for neither).
 *   - a double-quoted scalar (`"..."`) recognizes backslash escapes, the same generic "any `\X`
 *     pair does not end the string" treatment used throughout this file.
 *   - unlike shell/JS (where a raw string literally cannot span an unescaped newline — that is a
 *     syntax error in both, so stopping the scan at `\n` is the *correct*, not merely convenient,
 *     answer), a YAML quoted scalar legitimately folds across multiple lines. This walk does not
 *     cut a quoted scalar off at a raw newline the way `stripShellSource`/`stripJsSource` do;
 *     confirmed safe against this repository's own tracked YAML rather than assumed: neither
 *     tracked workflow file has a multi-line quoted scalar today, so this does not change any
 *     current verdict, but a scalar that never closes is well-defined here (blanked to end of
 *     file, the delimiter kept) rather than silently reinterpreted.
 *
 * Disclosed, not silently scored: a YAML block scalar (`|`/`>`, e.g. `run: |` in this repository's
 * own `ci.yml`) is walked as ordinary text, not as an indentation-delimited literal block — a `#`
 * inside one is still only a comment at a word boundary, which happens to be the right answer for
 * the one block scalar this repository currently tracks (an embedded shell step with no `#` in
 * it), but is not full block-scalar indentation tracking and does not claim to be.
 */
export const stripYamlSource = (text, blankStrings) => {
  const n = text.length;
  let out = "";
  let i = 0;

  const isWordBoundaryBefore = (idx) =>
    idx === 0 || text[idx - 1] === " " || text[idx - 1] === "\t" || text[idx - 1] === "\n";

  while (i < n) {
    const ch = text[i];

    if (ch === "#" && isWordBoundaryBefore(i)) {
      while (i < n && text[i] !== "\n") i++;
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

    if (ch === '"') {
      const start = i;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (text[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
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
        out += span.slice(0, 1) + blankKeepingNewlines(interior) + (closeLen ? '"' : "");
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
 * #689 round 17: the fifth instance of the same defect, disclosed and left unfixed at the end of
 * round 16 and sent back for exactly that reason. SQL's dispatch
 * (`stripStrings(stripSqlComments(text))` for the symbol view, `stripSqlComments(text)` alone for
 * the content view) has the identical two-pass, comment-blind-to-strings shape round 15 fixed for
 * JS/TS and round 16 fixed for shell/YAML.
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
 *     This is a real correction from `stripStrings`'s generic single-quote regex (which assumes
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
