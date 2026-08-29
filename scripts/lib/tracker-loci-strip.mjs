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
