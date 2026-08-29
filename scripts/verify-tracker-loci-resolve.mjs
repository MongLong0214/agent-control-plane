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
 *   - a cited line is beyond the file's current length                      → STALE (weak signal:
 *     a file can stay long after the cited region is rewritten, see below)
 *   - a cited symbol (the repo's own `` `path` — `symbol` `` table
 *     convention, e.g. #597's own migration table) does not resolve under `src/`  → STALE
 *   - a cited code line, quoted alongside its file:line, no longer appears
 *     anywhere in that file (elision-tolerant: `...`/`()` stand for "and more") → STALE
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
 * Usage: node scripts/verify-tracker-loci-resolve.mjs [--json] [--strict] [--issues-file=<path>] [--repo-root=<path>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
const SRC = join(repoRoot, "src");
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      })
    : [];
const srcFiles = walk(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

const symbolResolves = (symbol) => {
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return srcFiles.some((f) => pattern.test(f.text));
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
 * Resolves a cited path against the tracked tree, tolerating a citation that names less than the
 * full path.
 *
 *   1. the literal cited path, if it is tracked
 *   2. exactly one tracked file whose path ends with `/<cited>` — the citation named a suffix of
 *      the real path (a wrong or missing leading directory, e.g. `continuity/continuity-kernel.ts`
 *      for `src/continuity/continuity-kernel.ts`)
 *   3. exactly one tracked file with the same basename — the citation named only the filename
 *
 * More than one match at a step is reported as its own reason: the citation is not wrong, it is
 * ambiguous, and ambiguity is a fact about the citation the same way missing is.
 */
const resolvePath = (cited) => {
  if (trackedFiles.includes(cited)) return { path: cited, ambiguous: null };
  const bySuffix = trackedFiles.filter((f) => f.endsWith(`/${cited}`));
  if (bySuffix.length === 1) return { path: bySuffix[0], ambiguous: null };
  if (bySuffix.length > 1) return { path: null, ambiguous: bySuffix };
  const base = cited.split("/").pop();
  const byBasename = trackedFiles.filter((f) => f.split("/").pop() === base);
  if (byBasename.length === 1) return { path: byBasename[0], ambiguous: null };
  if (byBasename.length > 1) return { path: null, ambiguous: byBasename };
  return { path: null, ambiguous: null };
};

// --- extraction --------------------------------------------------------------------------------
// Longer alternatives that share a prefix with a shorter one must come first: JS regex
// alternation takes the first branch that matches and does not backtrack for a longer one, so
// "js|json" would match only "package.js" out of "package.json" and silently drop the "on".
const FILE_EXT = "tsx|ts|mjs|cjs|json|js|sh|sql|md|yaml|yml";
const PATH_RE = new RegExp(`\\b([A-Za-z0-9_][\\w-]*(?:/[\\w.-]+)*\\.(?:${FILE_EXT}))\\b(?::(\\d+)(?:-(\\d+))?)?`, "g");
const URL_RE = /https?:\/\/\S+/g;
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
  if (/^\./.test(rest)) return true; // identifier.member — dotted access, first thing cited
  if (/^\s*=[^=]/.test(rest)) return true; // identifier = value — assignment, first thing cited
  return false;
};

const extractFromBody = (body) => {
  const lines = body.split("\n");
  let inFence = false;
  const seenPath = new Set();
  const seenSymbolRow = new Set();
  const seenNonDurable = new Set();
  const pathCitations = [];
  const symbolCitations = [];
  const nonDurable = [];

  for (const rawLine of lines) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }

    for (const m of rawLine.matchAll(NON_DURABLE_RE)) {
      const path = m[0].replace(/[.,;:)]+$/, "");
      if (!seenNonDurable.has(path)) {
        seenNonDurable.add(path);
        nonDurable.push({ path });
      }
    }

    const urlSpans = [...rawLine.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length]);
    const insideUrl = (idx) => urlSpans.some(([s, e]) => idx >= s && idx < e);

    for (const m of rawLine.matchAll(PATH_RE)) {
      if (insideUrl(m.index)) continue;
      const path = m[1];
      const startLine = m[2] ? Number(m[2]) : null;
      const endLine = m[3] ? Number(m[3]) : null;
      let content = null;
      if (inFence && startLine !== null) {
        const rest = rawLine.slice(m.index + m[0].length).replace(/←.*$/, "").trim();
        if (rest.length > 0 && looksLikeCode(rest)) content = rest;
      }
      const key = `${path}:${startLine ?? ""}:${endLine ?? ""}`;
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
    if (citation.startLine === null) continue; // bare path, resolves, nothing more to say

    const abs = resolve(repoRoot, resolved.path);
    const text = readFileSync(abs, "utf8");
    const fileLines = text.split("\n").length;
    if (citation.startLine > fileLines) {
      stale.push({
        issue,
        citation: citation.raw,
        reason: `${resolved.path} has ${fileLines} line(s); line ${citation.startLine} is beyond it`,
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
      const to = Math.min(windowLines.length, (citation.endLine ?? citation.startLine) - 1 + CONTENT_SEARCH_WINDOW);
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

    advisory.push({
      issue,
      citation: citation.raw,
      reason: `${resolved.path} still resolves at line ${citation.startLine} — line numbers rot; name the symbol instead (#597)`,
    });
  }

  for (const symbolCitation of symbolCitations) {
    for (const symbol of symbolCitation.symbols) {
      if (!symbolResolves(symbol)) {
        stale.push({
          issue,
          citation: symbolCitation.raw,
          reason: `symbol \`${symbol}\` does not resolve anywhere under src/`,
        });
      }
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
