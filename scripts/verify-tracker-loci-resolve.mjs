#!/usr/bin/env node
/**
 * #597's rule, turned into a script: an issue that cites a locus is making a claim about the
 * repository other than itself, and that claim goes stale the moment the code moves — silently,
 * because nothing about the issue changes when it does. Measured three times in one working day
 * (#650, #649, #630): work got dispatched from an issue body whose cited loci had already moved,
 * and every one of those was a citation nobody re-checked before acting on it.
 *
 * #597's own rule for the one classification that asserts something about a system other than
 * the one being edited: "Loci are named by symbol, never by line number... a renamed symbol
 * makes the search return nothing, and nothing is a visible failure." This script is the general
 * form of that, applied to every open issue's own citations rather than one migration table.
 *
 * ## What counts as stale
 *
 *   - a cited file does not exist at all                                    → STALE
 *   - a cited line is <= 0, or an end line before its start                 → STALE (impossible
 *     regardless of the file's length; see round 3 below)
 *   - a cited line is beyond the file's current length                      → STALE (weak signal:
 *     a file can stay long after the cited region is rewritten, see below)
 *   - a cited symbol (the repo's own `` `path` — `symbol` `` table convention, e.g. #597's own
 *     migration table) does not appear in the named file, outside whatever that file's own
 *     language treats as a comment or a quoted string — `codeSearchScope` names the exact scope
 *     per extension, and an extension with no supported comment syntax is disclosed as a plain
 *     text search rather than silently inheriting another language's rules → STALE (this is a
 *     text search, not declaration verification; see rounds 3 and 4 below for why)
 *   - a cited code line, quoted alongside its file:line — inline in a sentence or inside a fenced
 *     block, both are read the same way — no longer appears anywhere in that file (elision-
 *     tolerant: `...`/`()` stand for "and more")                            → STALE
 *
 * The last one is the one that actually catches #649's real citation. `binding-registry.ts:163`
 * is still in range — that file is 973 lines long — so the length check alone passes it. What
 * changed is the *content*: `const actorId = this.mintActor(...)` (unconditional mint) is not
 * what line 163 says any more, and it does not appear anywhere else in the file either, because
 * #657 rewrote the mechanism to reuse an actor first. A check that only asked "is the line
 * number still in range" would have missed the one case this script exists to catch.
 *
 * ## Any `file:line` citation is ADVISORY, whether or not it is stale
 *
 * This is #597's actual rule, not a side effect of this script: a line number is a timestamp
 * wearing a citation's clothes, and it is worth saying so on a citation that still resolves,
 * because "still resolves today" is not "will resolve next week". ADVISORY does not fail the
 * build by default (`--strict` promotes it); STALE and NON_DURABLE do.
 *
 * ## Why there is no allow-list for "this citation is legitimately historical"
 *
 * An allow-list keyed by file:line goes stale exactly the way the citation it exempts does —
 * the exemption is itself an unmaintained record of a fact that used to be true. So there isn't
 * one. Instead, the content-match above already does the job an exemption list would have done:
 * a citation whose *line number* rotted but whose *quoted content* still exists somewhere in the
 * file is not stale, it is exactly the case #597 describes ("a renamed symbol" analog for a
 * moved line) — reported ADVISORY, not STALE, with no list to maintain. A citation whose content
 * is genuinely gone is not "historical", it is the #603/#676 shape this script exists to name:
 * an assertion about something the filesystem no longer has. If a human judges a citation is
 * deliberately about the past, that is an edit to the issue, not an entry in a parallel list that
 * would itself need maintaining.
 *
 * ## Non-durable paths (#603, #676)
 *
 * A citation of `/private/tmp`, `/tmp`, or a session scratchpad is a custody claim the filesystem
 * will not honor. Reported as its own category because the fix is different: commit it, or admit
 * it is gone.
 *
 * ## Scope: issue bodies only
 *
 * Comments can supersede a body's citation (#649's own later comments record exactly that), but a
 * body making a claim without its comments being read is the failure mode this exists to catch —
 * checking the body is checking what a reader sees first and is likeliest to act on. Extending to
 * comments is a reasonable follow-up, not a correctness gap in what this checks today.
 *
 * ## GitHub unreachable
 *
 * Exit 2, distinct from exit 1, mirroring `ssot-report.mjs`'s reasoning for the same distinction:
 * "nobody could look" is not the same answer as "the citations disagree with the tree", and
 * conflating them sends someone hunting a disagreement that may not exist.
 *
 * `--issues-file` is a fixture seam for this gate's own regression tests; normal CI and operator
 * use must query GitHub directly.
 *
 * ## Fixed after an independent review found the check had the blind spot it exists to catch
 *
 * Four counterexamples, each a citation this script passed in total silence:
 *
 *   1. `graveyard/continuity-kernel.ts` — a fabricated directory, real basename. The basename
 *      fallback (needed — see `resolvePath`) resolved it with no signal that the directory it
 *      named was wrong. Fixed: a basename-only resolution is now ADVISORY, always, whether or
 *      not the citation carries a line number.
 *   2. `README.md:1-999999` — a valid start line hid an end line no file could have. Fixed: the
 *      end of a cited range is checked against the file's length too, not just the start.
 *   3. `.py` citations (real, in #675/#676) and GitHub `path#L123` anchors were not recognized at
 *      all, so a citation in either form was silently never checked — indistinguishable from a
 *      citation that resolved. Fixed: both are now extracted (see `FILE_EXT` and `PATH_RE`).
 *   4. `` `src/core/reason-codes.ts` — `failover` `` — a real symbol paired with the wrong file
 *      passed, because the symbol was searched for anywhere under `src/`, not in the file the row
 *      names. That defeats #597's actual rule, which is that the *named* site holds the symbol.
 *      Fixed: a symbol citation now resolves the row's own path first and searches only that file.
 *
 * Fixing (3) surfaced a fifth defect on its own: once `.py` was recognized, a `/private/tmp/…/x.py`
 * citation matched twice — once as NON_DURABLE (correct) and once as an ordinary path citation
 * STALE ("does not exist", true but redundant and pointing at the wrong fix). Fixed by excluding
 * path-citation extraction inside a NON_DURABLE span.
 *
 * ## Round 2: a second independent review found this script had NOT moved to CI correctly, plus
 * three more counterexamples the first fix round did not cover
 *
 *   [P0, design, not a script bug] This script had also become a required `project-ci` step. That
 *   was wrong: this is a fact about the open issue tracker, not about any one PR's diff, and it is
 *   *already* red on an unedited `main` — #649 cites a line #657 moved, and closing that needs no
 *   change to this repository's code. A required step in that state blocks every PR's merge on an
 *   issue-thread fact the diff never touched, for as long as the issue stays open — the coupling
 *   that gets a check disabled rather than fixed. Fixed by removing this script from `project-ci`
 *   entirely; it now runs *only* in `.github/workflows/tracker-loci.yml`'s daily schedule, which
 *   can fail loudly without failing anyone's merge. See that file's header for the full argument.
 *   [P1] A real GitHub blob permalink (`https://github.com/<owner>/<repo>/blob/<ref>/<path>#L…`)
 *   was rejected: the generic path regex, let loose on the URL's own text because a `#L` anchor
 *   was present, matched a fragment of the URL (`com/<owner>/<repo>/blob/main/README.md`) rather
 *   than the path the link names, and reported that fragment ambiguous against every tracked
 *   README. Fixed: a blob permalink to *this* repository (`repoSlug`, derived from `origin`) is
 *   now parsed structurally by `GITHUB_BLOB_RE` before the generic regex ever sees the line; the
 *   generic regex now excludes anything inside any URL, unconditionally.
 *   [P1] Symbol resolution was narrowed to the cited file in round 1, but stayed a plain text
 *   search — `` `binding-registry.ts` — `reconstitution` `` passed because the file's own comments
 *   discuss reconstitution in prose. Fixed: `readCode` strips `//` and `/* *\/` comments before a
 *   symbol search runs (documented limitation: it does not know about string literals, so a
 *   symbol name inside a quoted string still counts — narrower than the comment gap being closed).
 *   [P1] `.mts` — a real extension this repository tracks (`scripts/lib/collapse-trailer-paragraphs.d.mts`)
 *   — was missing from `FILE_EXT`, so a `.mts` citation was silently never checked. Added on the
 *   same evidence-first basis as `py`/`plist`; `.cts` stays out because nothing here is tracked.
 *
 * ## Round 3: a third independent review, also run against the shipped script through
 * `--issues-file` rather than a model of it
 *
 *   `README.md:0` (a line nothing is numbered), `README.md:197` on a file `text.split("\n")`
 *   over-counted as 197 lines when it has 196 (a trailing newline produces one extra empty
 *   split element that is not a line), and `README.md:20-10` (an inverted range) all read as
 *   "still resolves", ADVISORY, exit 0. Fixed: `countLines` drops the trailing empty split
 *   element, and `startLine < 1` / `endLine < startLine` are rejected as STALE before the file's
 *   length is even asked, because neither needs an answer to that question.
 *
 *   The dedup key for a path citation (`seenPath`) did not include the quoted content, so a bare
 *   `README.md:1` and a later fenced `README.md:1  const definitelyGone = true` collapsed to
 *   whichever the loop saw first — silently dropping the one that actually goes stale, since a
 *   citation with no quoted content has nothing to fail. Fixed: the content is part of the key.
 *
 *   Symbol resolution: see the comment beside `readCode`'s callers, below, for the full argument.
 *   In short — `` `buzz-adapter.ts` — `utf8` `` passed because `"utf8"` is a string-literal
 *   argument there, not a declared symbol, and this was the third round narrowing *where* a plain
 *   text search looks. The decision made here is to stop narrowing and instead say plainly what
 *   the check does: a text-occurrence search outside comments and quoted strings, not declaration
 *   verification. `stripStrings` closes the concrete counterexample; the wording of what STALE
 *   means for a symbol row changed from "does not resolve" to "does not appear as code" to match.
 *
 * ## Round 4: the claim was still ahead of the code — by less, but still ahead
 *
 *   Round 3's "outside a comment or quoted string" was true only for JavaScript's syntax, while
 *   `.py`/`.sh`/`.sql`/YAML were declared supported by being in `FILE_EXT` at all, and template
 *   literals were deliberately left unstripped in full. Two counterexamples, both run against the
 *   real script: `` `allowlist-proxy.py` — `Digest` `` passed with `Digest` sitting in a Python
 *   `#` comment (never stripped — round 2 only knew `//` and `/* *\/`); `` `session-registry.ts`
 *   — `legal` `` passed with `legal` sitting in a template literal's plain prose, not its `${…}`
 *   code (round 3 left every template literal untouched to protect its `${…}` expressions, and in
 *   doing so protected its prose too).
 *
 *   Decided by making the stripping match what is declared, rather than narrowing what is
 *   declared to match the stripping — both were offered as acceptable; this one keeps `.py`/
 *   `.sh`/`.sql`/YAML genuinely useful instead of downgrading them to a raw search. `readCode` now
 *   dispatches per extension (`codeSearchScope` names exactly what is excluded, per language: `#`
 *   for Python/shell/YAML, `--`/`` /* *\/ `` for SQL, the full JS set plus template-literal prose
 *   for the JS/TS family), and every extension with no supported comment syntax is disclosed as a
 *   plain text search in the report itself rather than silently inheriting JavaScript's rules.
 *   `stripTemplateLiteralProse` walks a template literal rather than stripping it whole: text
 *   outside `${…}` is blanked, a `${…}` span is copied through untouched (brace-balanced, so a
 *   nested object literal inside the expression does not end it early).
 *
 *   Separately: quoted content was only ever captured inside a fenced code block, so a citation
 *   written the ordinary way people actually write one — inline, mid-sentence, no ``` around it —
 *   was never content-checked at all. That is the #649 shape itself, the case this check exists
 *   for. Fixed by removing the fence requirement; `looksLikeCode` was already what kept ordinary
 *   prose from being read as a quote, so the fence was never doing separate work once that guard
 *   existed. Verifying this against the real tracker found one more thing the fence had been
 *   accidentally shielding: `looksLikeCode`'s dotted-access check only asked whether a dot
 *   followed the first word, and an ordinary sentence ending "...SSOT.md:99 structurally.**" (a
 *   markdown bold-close right after the period) matched it. Fixed by requiring a real identifier
 *   character after the dot, not just the dot itself.
 *
 * Usage: node scripts/verify-tracker-loci-resolve.mjs [--json] [--strict] [--issues-file=<path>] [--repo-root=<path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(
  process.cwd(),
  process.argv.find((a) => a.startsWith("--repo-root="))?.slice("--repo-root=".length) ?? defaultRepoRoot,
);
const asJson = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const issuesFile = process.argv.find((a) => a.startsWith("--issues-file="))?.slice("--issues-file=".length);

const listIssues = () => {
  if (issuesFile) return readFileSync(resolve(repoRoot, issuesFile), "utf8");
  try {
    return execFileSync(
      "gh",
      ["issue", "list", "--state", "open", "--json", "number,title,body,url", "--limit", "500"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    console.error(
      "verify-tracker-loci-resolve UNDETERMINED: GitHub issues could not be listed. Set GH_TOKEN " +
        "(in GitHub Actions, use GH_TOKEN: ${{ github.token }}) or authenticate gh locally.",
    );
    if (stderr) console.error(stderr);
    // Exit 2, not 1 — see the header. "Nobody could look" must not read as "the citations
    // disagree with the tree"; the former sends a reader hunting a mismatch that may not exist.
    process.exit(2);
  }
};

const issues = JSON.parse(listIssues());

// --- source tree, read once -------------------------------------------------------------------
const fileTextCache = new Map();
const readText = (relPath) => {
  if (!fileTextCache.has(relPath)) {
    fileTextCache.set(relPath, readFileSync(resolve(repoRoot, relPath), "utf8"));
  }
  return fileTextCache.get(relPath);
};

/**
 * How many lines a file has, for comparing against a cited line number. `text.split("\n").length`
 * over-counts by one whenever the file ends with a newline — which is every POSIX text file this
 * repository writes — because the split produces one trailing empty string after the final `\n`
 * that is not a line at all. A 196-line `README.md` read that way is 197 lines, and a citation of
 * line 197 ("one past the true end") passed as "still resolves" until this was fixed.
 */
const countLines = (text) => {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
};

/**
 * Removes `//` line comments and `/* ... *\/` block comments before a symbol search, so a symbol
 * mentioned only in prose about the code — a comment explaining what a mechanism used to do, or
 * warning about a related concept — does not count toward it. A comment mentioning a word is a
 * sentence about it, not code that holds it.
 *
 * `://` is protected explicitly so a URL inside a comment or string (`https://…`) is not itself
 * misread as the start of a line comment.
 */
const stripSlashComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ""))
    .join("\n");

/** `#` line comments — Python, shell, and YAML, the three `#`-comment extensions this checks. */
const stripHashComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/(?<!:)#.*$/, ""))
    .join("\n");

/** SQL's own comment forms: `--` to end of line, and the same `/* ... *\/` block form as JS. */
const stripSqlComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

/**
 * Removes the contents of single- and double-quoted string literals (kept as empty pairs, so
 * this does not fuse the tokens on either side together). `"utf8"` as an encoding argument is not
 * a citation's enforcing symbol resolving — it is a string that happens to spell the same word,
 * and without this a row pairing any file with any common string constant used in it would pass.
 * Applies across every language this check handles: Python, shell, YAML, and SQL all use the same
 * two quote characters for a string, and JS/TS's own `"`/`'` strings are the same shape.
 *
 * A measured gap, not a guessed one: a regex literal with a quote inside a character class
 * (`` /(["\\])/g `` — this repository has one, in `cli-adapters.ts`) is not told apart from a real
 * string boundary, because this is a text pass and does not know a regex literal from division.
 * Found while verifying an earlier fix: it did not change the primary verdict for any cited file,
 * only widened the "it also appears in" diagnostic aside on an unrelated file to include a false
 * hit. That aside is disclosed as a heuristic for exactly this reason — a pointer to go look, not
 * a second verified fact.
 */
const stripStrings = (text) =>
  text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");

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
const stripTemplateLiteralProse = (text) => {
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
        out += "  "; // an escape sequence in literal text; neither char is a symbol reference
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
 * What "does not appear as code" means, per language — see the round-4 note beside this
 * function's callers for why this is stated explicitly rather than left implicit. Only the
 * extensions listed here get a comment/string-aware search; everything else is disclosed as a
 * plain text search with no exclusions, rather than silently applying JavaScript's rules to a
 * file that does not use them.
 */
const JS_FAMILY_EXTS = new Set(["ts", "tsx", "js", "mjs", "cjs", "mts"]);
const HASH_COMMENT_EXTS = new Set(["py", "sh", "yaml", "yml"]);
const SQL_EXTS = new Set(["sql"]);

const extensionOf = (relPath) => {
  const dot = relPath.lastIndexOf(".");
  return dot === -1 ? "" : relPath.slice(dot + 1).toLowerCase();
};

/** A short, human-readable name for what a symbol search excludes in this file's language. */
const codeSearchScope = (relPath) => {
  const ext = extensionOf(relPath);
  if (JS_FAMILY_EXTS.has(ext)) return "outside a `//`/`/* */` comment, a quoted string, or template-literal prose";
  if (HASH_COMMENT_EXTS.has(ext)) return "outside a `#` comment or quoted string";
  if (SQL_EXTS.has(ext)) return "outside a `--`/`/* */` comment or quoted string";
  return `as plain text (no comment or string exclusion applies to .${ext} files)`;
};

const codeTextCache = new Map();
const readCode = (relPath) => {
  if (!codeTextCache.has(relPath)) {
    const raw = readText(relPath);
    const ext = extensionOf(relPath);
    let code;
    if (JS_FAMILY_EXTS.has(ext)) {
      code = stripStrings(stripTemplateLiteralProse(stripSlashComments(raw)));
    } else if (HASH_COMMENT_EXTS.has(ext)) {
      code = stripStrings(stripHashComments(raw));
    } else if (SQL_EXTS.has(ext)) {
      code = stripStrings(stripSqlComments(raw));
    } else {
      code = raw; // no supported comment syntax for this extension — see codeSearchScope
    }
    codeTextCache.set(relPath, code);
  }
  return codeTextCache.get(relPath);
};

/**
 * Every tracked file, repo-root-relative with forward slashes. Used to resolve a citation that
 * names a file by less than its full path from the repo root — which is most of them: an issue
 * discussing `binding-registry.ts` inside a paragraph about the binding registry does not repeat
 * `src/session/` on every line, and a check that only accepts the literal full path would call
 * nearly every real citation in this repository "missing" and be false in the way that gets a
 * check switched off.
 */
const trackedFiles = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

/**
 * `owner/repo`, lowercased, derived from `origin` so a GitHub blob permalink can be told apart
 * from a link to someone else's repository (of which #597's own body has one, to `docs/adr`
 * elsewhere entirely). `null` if there is no such remote — a permalink is then treated as an
 * ordinary URL and skipped, never as a crash.
 */
const repoSlug = (() => {
  try {
    const originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const m = originUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  } catch {
    return null;
  }
})();

/**
 * Resolves a cited path against the tracked tree, tolerating a citation that names less than the
 * full path.
 *
 *   1. the literal cited path, if it is tracked                                    → "exact"
 *   2. exactly one tracked file whose path ends with `/<cited>` — the citation named a suffix of
 *      the real path (a wrong or missing leading directory, e.g. `continuity/continuity-kernel.ts`
 *      for `src/continuity/continuity-kernel.ts`)                                  → "suffix"
 *   3. exactly one tracked file with the same basename — the citation named only the filename,
 *      or named a directory that is not the real one at all                       → "basename"
 *
 * More than one match at a step is reported as its own reason: the citation is not wrong, it is
 * ambiguous, and ambiguity is a fact about the citation the same way missing is.
 *
 * `matchKind` matters past this function: a "basename" resolution is the weakest of the three —
 * it ignores every directory component the citation gave, so a fabricated, wrong directory with
 * a real filename (`graveyard/continuity-kernel.ts`) resolves exactly as readily as an honest bare
 * filename (`continuity-kernel.ts`) does. The caller reports "basename" resolutions as ADVISORY
 * even with no line number at all — the citation resolved, but not the way it was written, and
 * that is worth a reader's attention the same way a rotting line number is. A "suffix" match kept
 * every directory the citation specified and only lacked a prefix, which is a far stronger
 * signal that the citation actually meant this file, so it stays silent.
 */
const resolvePath = (cited) => {
  if (trackedFiles.includes(cited)) return { path: cited, ambiguous: null, matchKind: "exact" };
  const bySuffix = trackedFiles.filter((f) => f.endsWith(`/${cited}`));
  if (bySuffix.length === 1) return { path: bySuffix[0], ambiguous: null, matchKind: "suffix" };
  if (bySuffix.length > 1) return { path: null, ambiguous: bySuffix, matchKind: null };
  const base = cited.split("/").pop();
  const byBasename = trackedFiles.filter((f) => f.split("/").pop() === base);
  if (byBasename.length === 1) return { path: byBasename[0], ambiguous: null, matchKind: "basename" };
  if (byBasename.length > 1) return { path: null, ambiguous: byBasename, matchKind: null };
  return { path: null, ambiguous: null, matchKind: null };
};

// --- extraction --------------------------------------------------------------------------------
// Longer alternatives that share a prefix with a shorter one must come first: JS regex
// alternation takes the first branch that matches and does not backtrack for a longer one, so
// "js|json" would match only "package.js" out of "package.json" and silently drop the "on".
// `py` and `plist` are here because they are real, measured citation forms in this tracker's own
// issues (#675, #676 cite `.py` scripts; #395/#400/#559/#564 cite the deploy `.plist`) — not a
// guess at what else might show up. Extensions that looked plausible but turned out to collide
// with ordinary property access (`process.env`, `console.log`, `cp.db`) were deliberately left
// out after checking: adding them would misread prose as a citation of a file that was never cited.
// `mts` is here because this repository tracks one (`scripts/lib/collapse-trailer-paragraphs.d.mts`)
// — a real extension in this tree, not a guess; `cts` is not tracked anywhere and stays out on the
// same evidence-first basis.
const FILE_EXT = "tsx|ts|mts|mjs|cjs|json|js|plist|py|sh|sql|md|yaml|yml";
// The line-number suffix comes in the two forms this tracker's issues actually use: `:123` /
// `:123-456` (the convention #649 and #597's own table use), and a GitHub-style `path#L123` /
// `path#L123-L456` anchor. Both land in the same two named groups so extraction does not care
// which form a citation used.
const PATH_RE = new RegExp(
  `\\b([A-Za-z0-9_][\\w-]*(?:/[\\w.-]+)*\\.(?:${FILE_EXT}))\\b` +
    `(?::(?<cs>\\d+)(?:-(?<ce>\\d+))?|#L(?<as>\\d+)(?:-L?(?<ae>\\d+))?)?`,
  "g",
);
const URL_RE = /https?:\/\/\S+/g;
// A GitHub blob permalink, parsed structurally rather than through the generic PATH_RE run over
// its raw text. Letting the generic regex loose inside a URL was the earlier bug: it greedily
// matched a fragment of the URL itself (`com/<owner>/<repo>/blob/main/README.md`), not the path
// the link actually names, and reported that fragment ambiguous against every tracked README.
const GITHUB_BLOB_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/[^/\s]+\/([^\s#)]+)(?:#L(\d+)(?:-L?(\d+))?)?/g;
const SYMBOL_ROW_RE = /`([\w./-]+\.\w+)`\s*(?:—|--?)\s*((?:`[\w.$]+`,?\s*)+)/g;
const NON_DURABLE_RE = /(\/private\/tmp\/[^\s`)]+|(?<![\w/])\/tmp\/[^\s`)]+)/g;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How far from the cited line a quoted snippet may still be found and count as "present". */
const CONTENT_SEARCH_WINDOW = 60;

/**
 * Turns a quoted code snippet into a regex that still matches after elision. `...` (or `…`)
 * stands for "omitted", the same convention the repository's own issue bodies use when quoting a
 * call with its arguments left out. Empty parens `()` get the same treatment — a citation writing
 * `bindings.bind()` to mean "calls bind" should not be refuted by the call actually taking
 * arguments, only by the call not existing at all.
 */
const snippetPattern = (snippet) => {
  const trimmed = snippet.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(/\.\.\.|…/);
  const escaped = parts.map((part) =>
    escapeRegex(part.trim()).split("\\(\\)").join("\\([^)]*\\)").replace(/\s+/g, "\\s+"),
  );
  const source = escaped.filter((p) => p.length > 0).join(".*?");
  // "s" (dotall): an ellipsis in a quoted citation stands for omitted *lines* as often as omitted
  // arguments — `for (…) { … await this.router.route(…) }` elides the loop body, not one call's
  // args — so the wildcard between fragments has to be able to cross a newline, or a perfectly
  // current multi-line quote is reported stale for a reason that is about this checker, not the
  // tree.
  return source.length > 0 ? new RegExp(source, "s") : null;
};

const CODE_KEYWORDS = new Set([
  "const", "let", "var", "return", "if", "else", "function", "class", "export", "import",
  "await", "async", "new", "throw", "switch", "case", "for", "while", "try", "catch",
  "this", "super", "private", "public", "static",
]);

/**
 * Extracts an inline citation's quoted content from the rest of its line — not just trims it. An
 * inline citation is written mid-sentence, with its own code span closing right where the match
 * ends: "`binding-registry.ts:163` — `const actorId = this.mintActor(...)` no longer holds." The
 * text after the match is `` ` — `const actorId = this.mintActor(...)` no longer holds. ``, and a
 * plain trim would keep the trailing sentence as if it were quoted code, checking a citation
 * against a string that was never a line in any file.
 *
 * So: drop the citation's own closing delimiter, drop the markdown separator (whitespace, a dash,
 * a colon) between citation and quote, then — if what is left opens with a backtick or quote —
 * read only up to its matching close and discard everything after. A citation with no wrapping
 * quote around its content (the fenced convention: `path:line   bare code`, nothing else on the
 * line) falls through unchanged, which is the behaviour this replaces and must not disturb.
 */
const cleanInlineTail = (text) => {
  let t = text.replace(/←.*$/, "").trimEnd();
  t = t.replace(/^\s*[`'"]/, ""); // the citation's own closing delimiter, if it had one
  t = t.replace(/^[\s:—–-]+/, ""); // the separator between a citation and what follows
  for (const quote of ["`", '"', "'"]) {
    if (t.startsWith(quote)) {
      const closing = t.indexOf(quote, 1);
      return (closing === -1 ? t.slice(1) : t.slice(1, closing)).trim();
    }
  }
  return t.replace(/[`'"]\s*$/, "").trim();
};

/**
 * A trailing description is only checkable as literal content if the citation itself opens with
 * code, not with a description that merely mentions some. Requiring only *some* code-shaped
 * fragment anywhere in the text is not enough — "calls bindings.bind()" contains a real call, but
 * "calls" is the citer's paraphrase and does not appear next to it in the source, so a substring
 * match on the whole trailing text would call a perfectly current citation stale for a reason
 * that is about the paraphrase, not the tree. Requiring code at the very start is what a quoted
 * line looks like (`const actorId = this.mintActor(...)`, `sameProviderReplacement = outgoing…`);
 * a citation that instead reads as prose about a locus (`reconstitution is allowed when…`, a
 * state-machine row written `state → guard(...)`) is real information but not a literal quote,
 * and is left to the weaker line-in-bounds check rather than asserted stale on a technicality of
 * how it was phrased.
 */
const looksLikeCode = (text) => {
  const stripped = text.replace(/\(#\d+\)/g, "").trim();
  const firstToken = stripped.match(/^[A-Za-z_$][\w$]*/);
  if (!firstToken) return false;
  const word = firstToken[0];
  const rest = stripped.slice(word.length);
  if (CODE_KEYWORDS.has(word)) return true;
  if (/^\s*\(/.test(rest)) return true; // identifier( — a call, first thing cited
  // identifier.member — dotted access, first thing cited. The character right after the dot has
  // to start a real member name: a dot followed by anything else (end of string, whitespace,
  // punctuation) is an ordinary sentence-ending period, not code. Found live, once inline citations
  // started being read the same way fenced ones are: "...violates SSOT.md:99 structurally.**" —
  // a real citation, real prose — matched `/^\./` on "structurally.**" and was almost read as
  // quoted code because a markdown bold-close sat right after the period.
  if (/^\.[A-Za-z_$]/.test(rest)) return true;
  if (/^\s*=[^=]/.test(rest)) return true; // identifier = value — assignment, first thing cited
  return false;
};

const extractFromBody = (body) => {
  const lines = body.split("\n");
  const seenPath = new Set();
  const seenSymbolRow = new Set();
  const seenNonDurable = new Set();
  const pathCitations = [];
  const symbolCitations = [];
  const nonDurable = [];

  for (const rawLine of lines) {
    // A fence delimiter line never itself matches a citation; skipped so nothing downstream has
    // to know whether it is inside or outside a fence — quoted content is read the same way
    // either side (see the `looksLikeCode` call below and round 4's note on inline citations).
    if (/^\s*```/.test(rawLine)) continue;

    const nonDurableSpans = [];
    for (const m of rawLine.matchAll(NON_DURABLE_RE)) {
      const path = m[0].replace(/[.,;:)]+$/, "");
      nonDurableSpans.push([m.index, m.index + path.length]);
      if (!seenNonDurable.has(path)) {
        seenNonDurable.add(path);
        nonDurable.push({ path });
      }
    }

    const urlSpans = [...rawLine.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length]);
    const insideUrl = (idx) => urlSpans.some(([s, e]) => idx >= s && idx < e);
    // A citation under `/private/tmp` or `/tmp` is already reported, once, as NON_DURABLE — its
    // message is the right one ("the filesystem will delete this"). Extracting the same text a
    // second time as an ordinary path citation double-reports it as STALE too ("does not exist"),
    // which is true but redundant and points a reader at "re-derive the claim from the code" for
    // something re-deriving cannot fix.
    const insideNonDurable = (idx) => nonDurableSpans.some(([s, e]) => idx >= s && idx < e);

    // A GitHub blob permalink to *this* repository is a precise, structured citation and is
    // parsed as one directly — see `GITHUB_BLOB_RE`'s comment for why the generic path regex
    // must not also be let loose on this text. A permalink to a different repository names
    // nothing in this tree and is dropped rather than misread as one of this repo's paths.
    if (repoSlug) {
      for (const m of rawLine.matchAll(GITHUB_BLOB_RE)) {
        const slug = `${m[1]}/${m[2]}`.toLowerCase();
        if (slug !== repoSlug) continue;
        const path = m[3].replace(/[.,;:)]+$/, "");
        const startLine = m[4] ? Number(m[4]) : null;
        const endLine = m[5] ? Number(m[5]) : null;
        // Content is always null for a URL citation (see below for why this field matters).
        const key = `${path}:${startLine ?? ""}:${endLine ?? ""}:`;
        if (seenPath.has(key)) continue;
        seenPath.add(key);
        pathCitations.push({ raw: m[0], path, startLine, endLine, content: null });
      }
    }

    for (const m of rawLine.matchAll(PATH_RE)) {
      if (insideNonDurable(m.index)) continue;
      // Any URL, not only a GitHub blob link: a fragment of a hyperlink's text is not a citation
      // in its own right, whether or not it superficially carries a line-number-shaped suffix —
      // that leniency is exactly what let a URL fragment through as a fabricated path before. A
      // link that does name a real locus in this repo is handled above, structurally.
      if (insideUrl(m.index)) continue;
      const path = m[1];
      const groups = m.groups ?? {};
      const startLine = groups.cs ? Number(groups.cs) : groups.as ? Number(groups.as) : null;
      const endLine = groups.ce ? Number(groups.ce) : groups.ae ? Number(groups.ae) : null;
      // Round 4: this only ran inside a fenced block, so a citation written the ordinary way
      // people actually write them — inline, in a sentence, no ``` around it — was never
      // content-checked at all. That is the #649 shape itself: the real citation this check was
      // built against, `` `binding-registry.ts:163` ... `const actorId = this.mintActor(...)` ``,
      // could just as easily have been written as one inline sentence, and would have gone
      // unchecked. `looksLikeCode` is what already keeps this from reading ordinary prose
      // ("still resolves at line 121, reconstitution is allowed when...") as quoted code; the
      // fence was never doing separate work once that guard exists.
      let content = null;
      if (startLine !== null) {
        const rest = cleanInlineTail(rawLine.slice(m.index + m[0].length));
        if (rest.length > 0 && looksLikeCode(rest)) content = rest;
      }
      // The quoted content is part of the identity, not decoration on top of it. Two citations of
      // the same `path:line` are two different claims when one of them also quotes code — a bare
      // `README.md:1` and a fenced `README.md:1  const definitelyGone = true` are not the same
      // citation, and the second is precisely the one likely to be stale. Keying on path/line
      // alone let the first (weaker, unquoted) citation's dedup entry silently absorb the second.
      const key = `${path}:${startLine ?? ""}:${endLine ?? ""}:${content ?? ""}`;
      if (seenPath.has(key)) continue;
      seenPath.add(key);
      pathCitations.push({ raw: m[0], path, startLine, endLine, content });
    }
  }

  for (const m of body.matchAll(SYMBOL_ROW_RE)) {
    const path = m[1];
    const symbols = [...m[2].matchAll(/`([\w.$]+)`/g)].map((s) => s[1]);
    const key = `${path}:${symbols.join(",")}`;
    if (seenSymbolRow.has(key)) continue;
    seenSymbolRow.add(key);
    symbolCitations.push({ raw: m[0], path, symbols });
  }

  return { pathCitations, symbolCitations, nonDurable };
};

// --- classification ------------------------------------------------------------------------
const stale = [];
const advisory = [];
const nonDurableFindings = [];

for (const issue of issues) {
  const { pathCitations, symbolCitations, nonDurable } = extractFromBody(issue.body ?? "");

  for (const nd of nonDurable) {
    nonDurableFindings.push({ issue, path: nd.path });
  }

  for (const citation of pathCitations) {
    const resolved = resolvePath(citation.path);
    if (resolved.ambiguous) {
      stale.push({
        issue,
        citation: citation.raw,
        reason: `${citation.path} names ${resolved.ambiguous.length} different tracked files ` +
          `(${resolved.ambiguous.slice(0, 5).join(", ")}${resolved.ambiguous.length > 5 ? ", …" : ""}) — ambiguous, not a locus`,
      });
      continue;
    }
    if (resolved.path === null) {
      stale.push({
        issue,
        citation: citation.raw,
        reason: `${citation.path} does not exist`,
      });
      continue;
    }

    // Fix (Sol counterexample 1): a citation that only resolved by matching a filename, ignoring
    // every directory it actually named, resolved *something* but not necessarily the thing it
    // meant — `graveyard/continuity-kernel.ts` is not a real location, and silently mapping it
    // onto `src/continuity/continuity-kernel.ts` hides that the citation was wrong about where
    // the file lives. Surfaced regardless of whether a line number is even present.
    const advisoryReasons = [];
    if (resolved.matchKind === "basename") {
      advisoryReasons.push(
        `${citation.path} resolved to ${resolved.path} only by matching its filename — the ` +
          "citation may name the wrong location; name the enforcing symbol or the full path instead",
      );
    }

    if (citation.startLine === null) {
      if (advisoryReasons.length > 0) advisory.push({ issue, citation: citation.raw, reason: advisoryReasons.join("; ") });
      continue; // bare path, resolves, nothing more to say
    }

    const text = readText(resolved.path);
    const fileLines = countLines(text);
    const citedEnd = citation.endLine ?? citation.startLine;

    // Fix (independent review, round 3): a coordinate does not have to be beyond the file to be
    // impossible. `README.md:0` names a line nothing is numbered, and no upper-bound check ever
    // sees it because 0 is never past the end of anything. `README.md:20-10` is not out of range
    // either — it is backwards, and "beyond the file" is not what is wrong with it. Both are
    // checked before the file is even asked how long it is, because neither needs an answer.
    if (citation.startLine < 1) {
      stale.push({
        issue,
        citation: citation.raw,
        reason: `line ${citation.startLine} does not exist — a citation's first line is 1, not ${citation.startLine}`,
      });
      continue;
    }
    if (citation.endLine !== null && citation.endLine < citation.startLine) {
      stale.push({
        issue,
        citation: citation.raw,
        reason: `cites lines ${citation.startLine}-${citation.endLine}, an inverted range — the end is before the start`,
      });
      continue;
    }

    // Fix (independent review, round 3): `text.split("\n")` counts a trailing newline as one more
    // (empty) line, so a 196-line file ending the way POSIX text files do reads as 197 lines —
    // exactly one past the true end, and exactly where `README.md:197` was let through as
    // "still resolves". `countLines` drops that trailing empty element before counting.
    if (citation.startLine > fileLines || citedEnd > fileLines) {
      stale.push({
        issue,
        citation: citation.raw,
        reason: `${resolved.path} has ${fileLines} line(s); line ${citedEnd} is beyond it`,
      });
      continue;
    }

    if (citation.content) {
      const pattern = snippetPattern(citation.content);
      // Searched near the cited line, not across the whole file. A file this size legitimately
      // repeats a shape — `binding-registry.ts` has a second, deliberate unconditional
      // `this.mintActor(...)` in an unrelated method 225 lines from the one #649 cited — and
      // matching anywhere would let that coincidence stand in for the cited line surviving.
      // The window is generous enough to tolerate the citation's line drifting from an ordinary
      // nearby edit; it is not generous enough to credit an unrelated function elsewhere in the
      // file with keeping this one's claim true.
      const windowLines = text.split("\n");
      const from = Math.max(0, citation.startLine - 1 - CONTENT_SEARCH_WINDOW);
      const to = Math.min(windowLines.length, citedEnd - 1 + CONTENT_SEARCH_WINDOW);
      const nearby = windowLines.slice(from, to).join("\n");
      if (pattern && !pattern.test(nearby)) {
        stale.push({
          issue,
          citation: citation.raw,
          reason:
            `quoted content "${citation.content}" no longer appears within ${CONTENT_SEARCH_WINDOW} lines of ` +
            `${resolved.path}:${citation.startLine}`,
        });
        continue;
      }
    }

    advisoryReasons.push(
      `${resolved.path} still resolves at line ${citation.startLine} — line numbers rot; name the symbol instead (#597)`,
    );
    advisory.push({ issue, citation: citation.raw, reason: advisoryReasons.join("; ") });
  }

  for (const symbolCitation of symbolCitations) {
    const resolved = resolvePath(symbolCitation.path);
    if (resolved.ambiguous) {
      stale.push({
        issue,
        citation: symbolCitation.raw,
        reason: `${symbolCitation.path} names ${resolved.ambiguous.length} different tracked files — ambiguous, not a locus`,
      });
      continue;
    }
    if (resolved.path === null) {
      stale.push({
        issue,
        citation: symbolCitation.raw,
        reason: `${symbolCitation.path} does not exist`,
      });
      continue;
    }

    // Fix (round 1): #597's rule is that the *named enforcement site* holds the symbol — pairing
    // `src/core/reason-codes.ts` with `failover` claims that file contains `failover`, not that
    // `failover` is spelled correctly somewhere in the codebase. Searching every file under
    // `src/` was satisfied by the symbol existing anywhere, crediting a row for a symbol that
    // lives in a completely different file than the one the row names.
    //
    // Fixed further (round 2): the narrowed search still read comments as code. `` `binding-
    // registry.ts` — `reconstitution` `` passed because the file's own comments discuss
    // reconstitution in prose. `stripComments` removes that before the search runs.
    //
    // Round 3, and a decision rather than a fourth narrowing: `stripStrings` (below) closes the
    // next hole the same shape found — `` `buzz-adapter.ts` — `utf8` `` passed because `"utf8"`
    // is a string literal argument in that file, not a symbol it declares. Stripping strings closes
    // *this* case, but the pattern underneath all three rounds is that each fix narrowed *where*
    // the search looks while it stayed a plain text search — never verification that the named
    // file *declares* the symbol, which is what #597 actually asked for.
    //
    // A real declaration check was considered and rejected for this codebase, on evidence rather
    // than a guess: spot-checking the symbols in `verify-enforcement-symbols.mjs`'s own LOCI table
    // turned up five different declaration shapes in ten symbols — a class method
    // (`isRoutableFor(...): boolean {`), an interface method signature with no body
    // (`ensurePrimaryCto(...): Promise<...>;`), a multi-line method signature whose `{` is several
    // lines below its name (`bindBuzzActor(\n  …\n): … {`), an object property holding an arrow
    // (`channelsGet: (channelId) => […]`), and a plain object property value (`BLIND_REVIEWER:
    // "BLIND_REVIEWER",`). A regex built to recognize all of these is exactly the "allow-list of
    // syntactic forms" that misses the next one silently — and a missed form here is a *false*
    // STALE against a symbol that is genuinely declared, which is worse than this check's current
    // honest limit: it erodes trust in the same way a check that is always noisy does, except by
    // being wrong instead of loud.
    //
    // So: this remains a text search, and says so. What it reports is renamed to describe that —
    // "does not appear" rather than "does not resolve" — rather than continuing to claim a
    // precision the search does not have. It still catches what matters most for #597's actual
    // failure mode: a symbol renamed away or deleted outright, which is what #649 and #657 were.
    // What it cannot catch: a symbol referenced but not declared in the cited file (an import, a
    // parameter of the same name) reading as present. That gap is disclosed, not hidden.
    //
    // Round 4: the claim above was still ahead of the code. Comment- and string-stripping only
    // understood JavaScript's syntax, while `.py`/`.sh`/`.sql`/YAML were declared supported by
    // being in `FILE_EXT` at all — so `` `allowlist-proxy.py` — `Digest` `` passed with `Digest`
    // sitting in a Python `#` comment, and `` `session-registry.ts` — `legal` `` passed with
    // `legal` sitting in a template literal's plain prose, not its `${…}` code. `readCode` now
    // dispatches by extension (`codeSearchScope` names exactly what it excludes, per language),
    // and a symbol row for an extension with no supported comment syntax is disclosed as a plain
    // text search rather than silently getting JavaScript's rules applied to it.
    const targetCode = readCode(resolved.path);
    for (const symbol of symbolCitation.symbols) {
      const pattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
      if (pattern.test(targetCode)) continue;
      // Scoped to files this check can actually apply a code-aware search to — the same set
      // `codeSearchScope` names. A match in an unsupported file (README.md's own prose, say) is
      // no more informative than the original miss: both are "the word appears somewhere", and
      // pointing at a doc page as if it were a competing enforcement site would be misleading
      // rather than helpful.
      const elsewhere = trackedFiles
        .filter((f) => f !== resolved.path)
        .filter((f) => {
          const ext = extensionOf(f);
          return JS_FAMILY_EXTS.has(ext) || HASH_COMMENT_EXTS.has(ext) || SQL_EXTS.has(ext);
        })
        .find((f) => pattern.test(readCode(f)));
      stale.push({
        issue,
        citation: symbolCitation.raw,
        reason: elsewhere
          ? `\`${symbol}\` does not appear ${codeSearchScope(resolved.path)} in ${resolved.path} — ` +
            // A pointer to go look, not a second verified fact: the same heuristic that catches
            // most strings and comments does not tell a regex literal's quote from a real one
            // (see `stripStrings`), so this hit is worth checking rather than trusting outright.
            `the same search also matches in ${elsewhere}, a different file than cited`
          : `\`${symbol}\` does not appear ${codeSearchScope(resolved.path)} in ${resolved.path}, ` +
            `or in any other tracked file`,
      });
    }
  }
}

// --- report ---------------------------------------------------------------------------------
const nothingToReport = stale.length === 0 && nonDurableFindings.length === 0 && advisory.length === 0;

if (asJson) {
  console.log(JSON.stringify({ stale, advisory, nonDurable: nonDurableFindings }, null, 2));
} else if (!nothingToReport) {
  if (stale.length > 0) {
    console.log(`STALE (${stale.length}):`);
    for (const item of stale) {
      console.log(`  #${item.issue.number} ${item.issue.title}`);
      console.log(`    ${item.citation}`);
      console.log(`    ${item.reason}`);
    }
  }
  if (nonDurableFindings.length > 0) {
    console.log(`\nNON_DURABLE (${nonDurableFindings.length}):`);
    for (const item of nonDurableFindings) {
      console.log(`  #${item.issue.number} ${item.issue.title}`);
      console.log(`    cites ${item.path}`);
      console.log("    this asserts custody over something the filesystem will delete — commit it, or accept it is gone");
    }
  }
  if (advisory.length > 0) {
    console.log(`\nADVISORY (${advisory.length}):`);
    for (const item of advisory) {
      console.log(`  #${item.issue.number} ${item.issue.title}`);
      console.log(`    ${item.citation}  —  ${item.reason}`);
    }
  }
  console.log(
    `\n${stale.length} stale, ${nonDurableFindings.length} non-durable path citation(s), ${advisory.length} advisory ` +
      `(line-number citations that still resolve) across ${issues.length} open issue(s).`,
  );
  if (stale.length > 0 || nonDurableFindings.length > 0) {
    console.log(
      "\nSTALE means the citation no longer describes the tree; re-derive the claim from the code, not the issue text.\n" +
        "NON_DURABLE means the citation names something the filesystem does not guarantee to keep;\n" +
        "commit it or accept it is gone. Neither is fixed by editing the issue to agree.",
    );
  }
  if (advisory.length > 0 && (stale.length === 0 && nonDurableFindings.length === 0)) {
    console.log("\nADVISORY does not fail the build; pass --strict to promote it to a failure.");
  }
}
// nothingToReport: print nothing at all, deliberately — see the header on why a check that
// always prints stops being read.

const failing = stale.length > 0 || nonDurableFindings.length > 0 || (strict && advisory.length > 0);
process.exit(failing ? 1 : 0);
