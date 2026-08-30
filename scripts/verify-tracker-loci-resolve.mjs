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
 *   - a cited code line — quoted with an explicit delimiter right after an inline citation
 *     (trusted unconditionally once that delimiter is found; see round 5 below for why an inline
 *     citation needs its own, and round 8 for why the heuristic below is dropped entirely for
 *     this branch), or the rest of a fenced citation's line, where the fence marks the *block* as
 *     code-shaped but — unlike an inline delimiter — does not by itself distinguish a literal
 *     quote from a plain-English description sharing the same fence (#649's own body does both;
 *     see round 8), so a fenced line is additionally required to read as code by `looksLikeCode`
 *     (a mixed-case identifier; a call, member, or assignment boundary right after the first word;
 *     or a declaration's trailing `{` — a fourth check, a line ending in `;`/`{`/`}`, was tried in
 *     round 10 and reverted in round 11 for being too blunt in the opposite direction; see
 *     `looksLikeCode`'s own comment) — searched against `readCode` (comment- and string-stripped,
 *     round 11 — the raw text let old code survive inside a comment near its own vanished call
 *     site pass as still-current, this check's original defect reappearing for a quoted snippet
 *     instead of a bare symbol) — no longer appears within `CONTENT_SEARCH_WINDOW` (±60) lines of
 *     the cited line, not the whole file (see round 8 for why the window is bounded rather than
 *     unbounded, and why an earlier version of this paragraph said "anywhere in the file" when the
 *     code never searched further than that) (elision-tolerant: `...`/`()` stand for "and more")
 *     → STALE, *if* the fenced line clears `looksLikeCode` — a fenced line that reads as a plain
 *     description rather than code is not checked at all, by design (round 8), and stays ADVISORY,
 *     and a fenced statement that reads as code but trips none of the three checks above (round 11's
 *     disclosed gap) is also not checked, and also stays ADVISORY
 *
 * The last one is the one that actually catches #649's real citation. `binding-registry.ts:163`
 * is still in range — that file is 973 lines long — so the length check alone passes it. What
 * changed is the *content*: `const actorId = this.mintActor(...)` (unconditional mint) is not
 * what line 163 says any more, and it does not appear within 60 lines of it either — checked, not
 * assumed: `binding-registry.ts` does have a second, unrelated `this.mintActor(...)` call 225
 * lines away (see `CONTENT_SEARCH_WINDOW`'s own comment), and the window is exactly what keeps
 * that coincidence from counting as the cited line surviving. #657 rewrote the mechanism to reuse
 * an actor first. A check that only asked "is the line number still in range" would have missed
 * the one case this script exists to catch.
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
 * ## Round 5: three counterexamples, one underlying shape — a hand-maintained list deciding what
 * counts, whichever direction it was enumerating
 *
 *   `` `session-registry.ts` — `definitelyMissing()` `` matched nothing: `SYMBOL_ROW_RE` did not
 *   allow parentheses on a symbol at all, so a citation written the way people actually write a
 *   function reference — with `()` — was invisible to the regex, not merely unresolved. Fixed:
 *   the row pattern accepts an optional `()`, dropped before the identifier is searched for (the
 *   parens mark "this is callable", they are not literal text a call site necessarily repeats,
 *   the same reasoning `snippetPattern`'s elision already uses for an empty `()`).
 *
 *   The other two were the same defect in opposite directions. `looksLikeCode`'s keyword list
 *   (round 4) recognised `const`/`let`/`return`/… and nothing else, so a genuinely vanished
 *   `` `interface DefinitelyGone {` `` read as ADVISORY — this check's own header claims a
 *   vanished quoted line is STALE, and it was not. Meanwhile `cleanInlineTail` + that same list
 *   let ordinary sentences ("this describes the banner text... its return value...") be read as
 *   quoted code, because `this` and `return` are common English words that also happen to be JS
 *   keywords. Widening the list fixes the first and worsens the second; narrowing does the
 *   reverse — the list itself was the problem, not its contents.
 *
 *   Two changes, addressing the two different halves of that one shape:
 *
 *   1. **The quoted/unquoted distinction now does the work.** An inline citation's content is
 *      read only from an *explicit* delimiter — backticks or quotes right after the citation
 *      (`readDelimitedSpan`) — never from unquoted trailing prose. There is no guess left to make
 *      about whether "this describes..." was meant as a quote: without a delimiter, it never was
 *      one, and `content` stays `null` unconditionally. A fenced line still needs no additional
 *      delimiter — the fence itself is the quotation mark, as it always has been.
 *   2. **`looksLikeCode` no longer enumerates keywords at all**, for text that is already known to
 *      be quoted (by either of the above). It asks two questions that do not name a single word:
 *      does a mixed-case identifier (`actorId`, `DefinitelyGone`, `ALLOWLIST_DIGEST`) appear —
 *      English does not capitalize mid-word, every language this check reads does, for exactly
 *      the names it declares; and, immediately after the first word only, does a call/member/
 *      assignment boundary follow (widened just for `{`, since a sentence essentially never ends
 *      in one regardless of what precedes it — see the comment beside it for why `(`/`.`/`=` stay
 *      narrow: a first attempt at widening all four caught "calls bindings.bind()", an English
 *      sentence about a call, as if it were the call itself, and lost the actual `bindings.bind(`
 *      to the paraphrase word in front of it).
 *
 *   What this still cannot do — stated rather than hidden: a declaration with no distinguishing
 *   capitalization and no boundary in its first word (`interface gone {`, all lowercase) is not
 *   recognised. That is a fact about how little three words of context can prove without a list,
 *   not a list this check forgot to extend — and the alternative, tuning the list a fourth time,
 *   is the failure mode this round exists to stop.
 *
 * ## Round 6: the same shape twice more — a bypass, and the extension list again
 *
 *   A GitHub blob permalink stored `content: null` unconditionally, so a permalink citing the
 *   exact line #649 quotes (`binding-registry.ts#L163` next to
 *   `` `const actorId = this.mintActor(...)` ``) passed as ADVISORY while the identical content
 *   cited as a plain path was correctly STALE. The URL's shape governs how a citation is *parsed*
 *   (`GITHUB_BLOB_RE` instead of `PATH_RE`); it has nothing to do with whether the text right
 *   after it gets checked, and treating the two together is what let the bypass in. Fixed by
 *   sharing one `contentAfter` helper between both extraction paths.
 *
 *   `FILE_EXT` was a hand-maintained extension list once more — evidence-first (every entry added
 *   because a real issue cited it), and still too narrow (`tests/fixtures/buzz-cli/cli-version.txt`,
 *   a real tracked file, was invisible because `.txt` was never added) and too broad ("runs on
 *   Node.js 22" matched and reported STALE because `.js` was). `git ls-files` is already this
 *   script's authority on what a file is (`trackedFiles`, `resolvePath`); the extension list was a
 *   hand-maintained gate standing in front of that authority rather than deferring to it.
 *
 *   The fix is the same move as round 5, applied to a different pair of categories: the extension
 *   is now generic (any `.word`), and what makes a bare mention worth resolving at all is a
 *   directory separator or an explicit line number — a signal specific enough not to be an
 *   ordinary word that happens to contain a dot. `deploy/egress/allowlist-proxy.py` and
 *   `Node.js:12` both qualify; bare `Node.js` does not, for the same reason bare `README.md` and
 *   `Node.js` are not distinguishable from each other on sight alone.
 *
 *   Measured against every open issue, snapshotted once and run through the version before this
 *   fix and the version after it, so the diff is this change and nothing else: five previously-
 *   flagged bare mentions disappear (`test_raw_sink_census.py`, `derive3.py`, `ARCHITECTURE.md`,
 *   `CLAUDE.md`, `AGENTS.md` — all directory-free, line-number-free), and two directory-qualified
 *   paths with extensions the old list never had newly resolve as STALE — reported at the time as
 *   `agent-control-plane/state.sqlite` and `hermes/state.db`; round 7 found and fixed the bug that
 *   made those two citations themselves wrong (both are actually `.agent-control-plane/state.sqlite`
 *   and `.hermes/state.db` — this text is corrected here for the same reason #576's retraction
 *   matters: a wrong citation reported as a finding is not a smaller version of a right one).
 *   Zero change to ADVISORY or NON_DURABLE. Reported here rather than only in the commit, because
 *   a change that only adds findings has not been checked for the kind it can also cause to
 *   disappear.
 *
 * ## Round 7: two more counterexamples, one of them already published as a real finding elsewhere
 *
 *   The generic extension in round 6 still required *an* extension, and a leading dot was still
 *   dropped by `\b`'s word/non-word transition — a dot with whitespace on the other side is
 *   non-word on both sides, so `\b` never fired there and the match silently began one character
 *   late. `.githooks/pre-commit` (real, tracked, no extension) was invisible regardless of what it
 *   resolved to, and `.github/workflows/ci.yml` read as `github/workflows/ci.yml`.
 *
 *   That dot-dropping is not hypothetical: round 6's own corpus report called
 *   `` `#576`'s `github/workflows/ci.yml` missing its leading dot `` a genuine catch, and that
 *   finding was repeated in a real comment closing #576. The actual line reads
 *   `` `.github/workflows/ci.yml` ``, correct, dot included — the checker had manufactured the
 *   "missing dot" itself by dropping one from a citation that had it. #576 has a posted retraction.
 *   A checker's first finding is the best opportunity to test the checker, not evidence it is
 *   right, and this round is the corrective measure: every "surfaced" claim below was checked
 *   against the actual issue text before being written down, including going back through this
 *   docstring's own round 6 entry, which turned out to carry the same bug (see above).
 *
 *   Fixed: `(?<![\w.])` replaces the leading `\b` (a lookbehind caring only whether the character
 *   before the match is a word character or a dot, so a dot after whitespace is included rather
 *   than skipped). An extensionless path is recognised only when a line number immediately follows
 *   it (a lookahead, `(?=:\d|#L\d)`) — *not* merely for having a directory separator, which was
 *   tried first and cost real precision: measured before trusting it, that version added 46 new
 *   "citations" to the same snapshot, almost none of them files — GitHub route fragments
 *   (`/repos/:o/:r/check-runs/:id` read as `r/check-runs`), state-pair notation
 *   (`READY/DRAINING`, `pending/failed`), bare directories with no filename (`src/github`), and
 *   digit/digit fractions (`16/580`, `22/22`). A directory separator alone is not specific enough;
 *   a line number is, the same way it already was for the with-extension case.
 *
 *   Separately: the symbol regex did not allow `#`, JavaScript's private-field/method sigil, which
 *   this codebase declares heavily (`turn-coordinator.ts`'s `#observe` among them) — so a citation
 *   of `#observe` and a citation of the fictitious `#definitelyMissing` produced identical output
 *   (nothing), unable to tell present from absent for an entire class of symbol. Fixed by allowing
 *   `#` in the symbol pattern, and by giving `symbolPattern` a lookbehind in place of `\b` for the
 *   same reason the path fix needed one — `#` is non-word on both sides of where it is actually
 *   written (`this.#observe(`, or `#observe(...) {` at a declaration), so `\b#observe` could never
 *   match a real declaration or call either.
 *
 *   Corpus diff (same snapshot, before and after, and every changed line checked against the real
 *   issue text before being trusted): the two mis-cited paths above corrected; zero new false
 *   positives from either fix, confirmed by re-running the directory-separator-only version first,
 *   measuring the flood it produced, and reverting to the line-number-gated version before this
 *   commit. The `#` symbol fix and the two dotfile counterexamples matched no existing symbol-row
 *   or path citation in the corpus at the time of this snapshot, so they change nothing there; they
 *   are proven by the constructed counterexamples and tests instead.
 *
 * ## Round 8: three more counterexamples run against the shipped script, one of them already
 * published as a real finding elsewhere — again
 *
 *   GitHub permalinks got a second look, and the same class of bug both times: the path capture
 *   excluded whitespace, `#`, and `)` but not a backtick, so `` `https://github.com/…/blob/main/
 *   README.md` `` — a backtick-wrapped link with no `#L` anchor to stop the match early — captured
 *   the closing backtick as part of the path and reported `README.md\`` missing. And `/blob/<ref>/
 *   <path>` assumed `<ref>` is exactly one segment, which is false for this repository's own
 *   branches — including the one this fix was written on,
 *   `feat/597-tracker-loci-resolve-or-the-check-says-so` — so a URL built from that branch name
 *   read `597-tracker-loci-resolve-…/README.md` as the file and reported it gone. Fixed by
 *   excluding backtick from every capture group, and by having `resolveBlobRefAndPath` split the
 *   ref-and-path span against two authorities in order: `knownRefs` (real branch and tag names,
 *   from `git for-each-ref`), longest match first, since a real ref can itself be a prefix of
 *   another one; then, if nothing there matches, the shortest split whose tail is an *exactly*
 *   tracked file. Only if both fail does it fall back to the plain one-segment guess — and a first
 *   version of this fix skipped that fallback entirely, returning `null` (silence) whenever no
 *   split resolved, on the theory that a wrong guess is worse than staying quiet. Run against its
 *   own test suite before trusting that: it cost the exact case this check exists for — a
 *   multi-segment ref to a *deleted* file can never resolve against tracked files at any split, by
 *   definition, so "resolves nowhere" and "the file is gone" became the same observation, and the
 *   fix made every such permalink go silent instead of STALE. `knownRefs` is what makes the
 *   fallback safe again: a real branch name verified independently of whether its file still
 *   exists is the thing the first version was missing, not the fallback itself.
 *
 *   Third: `looksLikeCode` was asked, a fourth time, to widen for a form it did not recognise —
 *   `` `README.md:1` — `return null;` `` is unmistakably code and unmistakably quoted, and came
 *   back ADVISORY because nothing about it trips the camelCase, call, dot, assignment, or brace
 *   checks. Rather than add a fifth check to the same heuristic, the question changed: an inline
 *   citation's content only exists because an *explicit* delimiter followed it — the author's own
 *   deliberate act of quoting, not a guess this script made — and asking "does it look like code"
 *   on top of that is a second guess layered on a signal already stronger than the guess. Dropped
 *   entirely for that branch. A fenced line's content has no delimiter of its own — the fence
 *   marks the block, not each row in it, as code — and `looksLikeCode` stays there: #649's own
 *   body mixes a literal quote with plain descriptions in the *same* fence, and checked directly
 *   against that fixture, dropping the heuristic for fenced content reintroduces the false STALE
 *   this whole check exists to avoid. Two branches, two different answers, because the strength of
 *   the "this is quoted" signal is not the same in both.
 *
 *   Separately, disclosed rather than left standing: this docstring's own "What counts as stale"
 *   section said a vanished quote "no longer appears anywhere in the file", and the search has
 *   always been `CONTENT_SEARCH_WINDOW` (±60) lines, not the whole file — a stated contract the
 *   code did not keep, which is the exact defect this whole PR exists to catch, found in its own
 *   header. Corrected above.
 *
 *   Corpus diff (same snapshot, before/after, every changed line checked against the real issue
 *   text): none. The one real permalink in the corpus (#597's own link to `docs/adr`) resolves
 *   `main` via `knownRefs` exactly as before and still reports `docs/adr does not exist` — true
 *   for a file-existence check even though `docs/adr` is a directory, not a file, and this script
 *   has no separate category for that distinction. Every other change this round addresses is
 *   proven by the constructed counterexamples and tests rather than a corpus shift, because none
 *   of these three bugs happened to match anything in the corpus at the time of this snapshot.
 *
 * ## Round 9: a ninth independent review, two of the three findings a test had itself pinned as
 * intended, plus a second look at the off-by-one shape round 8 had already fixed once
 *
 *   `` `HANDOFF-CEO-RESUME.md` `` — a real, missing file, backtick-quoted the ordinary way people
 *   actually cite one — passed in total silence: round 6's bare-mention skip (no directory, no
 *   line number) fires unconditionally, delimited or not. That was right for genuinely unquoted
 *   prose ("runs on Node.js 22") — nothing on sight tells that apart from a real bare filename —
 *   but round 5 already decided an explicit delimiter is decisive for an inline citation's
 *   *content*, and this is the same author act of quoting applied to the citation itself.
 *   `isExplicitlyDelimited` asks exactly that: a backtick or quote pair sitting right against the
 *   match, not a guess about the text's shape.
 *
 *   Measured against the real corpus before trusting that alone: it also passed
 *   `` `inbound_messages.turn_claim_json` `` (a real SQL column, #695) and
 *   `` `ConversationTurnCoordinator.claim` `` (a class.method reference, #693) as if either named a
 *   file — ten of sixteen corpus-diff additions were this shape, not a constructed edge case.
 *   Neither one's dotted suffix is an extension anything in this tracked tree actually uses, so
 *   `knownExtensions` — `trackedFiles` turned into the set of extensions this repository is really
 *   built from, the same authority-derived move round 6 made for "any .word" generally — gates the
 *   delimiter check rather than replacing it. The same gate also correctly excludes a real but
 *   deliberately untracked runtime file bare-cited the same way (`` `state.db` `` — "db" is not a
 *   tracked extension here), which is the right side to fall on: a check over the tracked tree has
 *   no basis to call a live, gitignored file "missing". Final corpus diff: five additions
 *   (`test_raw_sink_census.py`, `derive3.py`, `ARCHITECTURE.md`, `CLAUDE.md`, `AGENTS.md` — the same
 *   five round 6's own docstring named as the traded-off cost of the original skip), zero removed,
 *   every one checked against its real issue body before being trusted.
 *
 *   Second: the repo's own `` `path` — `symbol` `` table convention was the only symbol-row form
 *   `SYMBOL_ROW_RE` recognized. `` `definitelyMissing()` in `src/session/session-registry.ts` `` —
 *   the ordinary way people write English about code, reversed order, connected by "in" instead of
 *   "—" — matched nothing, unable to tell a present symbol from a fictitious one. `SYMBOL_PROSE_RE`
 *   recognizes it as a second, independent form rather than widening the first: both spans are
 *   already backtick-delimited, the same explicit-quoting signal the table form itself relies on,
 *   not a keyword scan of unquoted prose. Measured against the real corpus first: two genuine
 *   citations matched (`resolveEscalation` in `src/ceo/production-gate.ts`, #692;
 *   `completeReplyAndResolveTurn` in `src/ingress/ingress-guard.ts`, #639), zero incidental matches
 *   on anything else.
 *
 *   Third: `CONTENT_SEARCH_WINDOW`'s own upper bound was one line short of the ±60 it claims — a
 *   real, still-current citation exactly 60 lines past the one cited (`README.md:121` cited as
 *   `README.md:61`) read as vanished, because `citedEnd - 1 + CONTENT_SEARCH_WINDOW` folded the
 *   line-index-to-line-number `- 1` into the same term as the window width, one line short of
 *   where the slice's exclusive end needed to land. `citedEnd + CONTENT_SEARCH_WINDOW` is the
 *   corrected bound; the lower bound was already right (verified by construction, not merely by
 *   symmetry) and untouched.
 *
 * ## Round 10: a tenth independent review, both findings a place where this script's own stated
 * contract and its actual behaviour had drifted apart
 *
 *   `.gitignore:999999` (real, tracked, no extension, root-level — the file this repository would
 *   actually cite) and `.definitely-missing:42` (does not exist) both matched nothing: the
 *   extensionless branch of `PATH_RE` required a directory separator (`(?:/[\w.-]+)+`) on top of
 *   the line number, so a citation with nothing before the first `/` — the common case for a
 *   dotfile living at the repo root — was invisible regardless of what it resolved to. That
 *   requirement was round 6's own disambiguator for a *bare mention with nothing else to anchor
 *   it*; it was never the reason a *line-numbered* extensionless path was accepted; the line
 *   number already was, the same way it already is for the with-extension branch and already was
 *   for `.githooks/pre-commit:999999` (round 7) — that test only ever covered the directory-
 *   qualified case, not the root-level one. Fixed by loosening `+` to `*`: the directory segment
 *   is now optional wherever a line number follows. Measured against the real corpus before
 *   trusting this: zero new false positives — nothing pairs a bare word with an immediately-
 *   adjacent `:digit` or `#Ldigit` that is not a real citation; ordinary prose never places a
 *   colon-digit directly against a word with no separating space.
 *
 *   Retracted in round 11: "zero new false positives" was true of the corpus measured, not of the
 *   shape in general — `localhost:3000` and `HTTP:404` are the same `word:number` shape and the
 *   corpus at the time simply did not happen to contain either. A clean corpus diff is evidence
 *   about the corpus, not a proof about the regex; see round 11 for the actual fix.
 *
 *   Second: this docstring's own "What counts as stale" section claimed a fenced citation's
 *   vanished code is caught because "the fence itself is the delimiter", the same unconditional
 *   trust round 8 gave an inline citation's explicit delimiter — but the code never matched that
 *   claim. A fenced line still runs through `looksLikeCode` (round 8 kept it there deliberately,
 *   because #649's own body mixes a literal quote and a plain description in the *same* fence, so
 *   the fence alone cannot tell the two apart the way an inline backtick can). `` ```ts\nREADME.md:1
 *   return null;\n``` `` — unmistakably code, unmistakably vanished — passed as ADVISORY because
 *   `return null;` tripped none of `looksLikeCode`'s prior checks: no mixed-case identifier, and no
 *   call/dot/assignment/brace sitting immediately after "return" (a word, not a boundary). Fixing
 *   this is not "drop the heuristic" (round 8 already tried and reverted that exact move for this
 *   branch) and not "add a fifth keyword" (round 5's whole point); it is a fourth structural
 *   question, in the same non-lexical family as the first three: does the line end in `;`, `{`, or
 *   `}` — a statement terminator or a block boundary, which is not how an English sentence ends
 *   (a sentence ends in a period, a question mark, a closing paren, or a word) but is exactly how
 *   a real line of JS/TS-shaped code tends to. Checked directly against #649's own fixture before
 *   trusting it: neither of its real fenced prose lines ends in `;`, `{`, or `}` once the
 *   `(#619)`-style aside is stripped, so the round 8 false-STALE this heuristic exists to prevent
 *   does not reopen. The docstring bullet above is corrected to say what the code actually does:
 *   a fenced line is checked only if it clears `looksLikeCode`, plainly, rather than claiming the
 *   fence alone is decisive.
 *
 *   Reverted in round 11: the reasoning was true of most English prose, not all of it — a
 *   description enumerating a set (`role ∈ {ADMIN, USER}`) or ending a clause with a semicolon by
 *   choice trips the same check a real statement does. See round 11 for what replaced it (nothing;
 *   the gap is disclosed instead) and why.
 *
 * ## Round 11: an eleventh independent review, both of the reviewer's own suggestions from round
 * 10 landing badly, plus this script's original defect reappearing in the direction it was fixed
 * for
 *
 *   `localhost:3000` and `HTTP:404` both matched `PATH_RE`'s extensionless branch and reported
 *   STALE — "localhost does not exist" — because round 10 loosened the directory requirement to
 *   zero-or-more for *any* bare word once a line number followed, on the theory that the number
 *   alone was signal enough. It is not: `word:number` is also a port, a status code, or any other
 *   colon-separated pair, and round 7's own corpus measurement had already found that shape in
 *   abundance the last time a requirement was dropped here (`READY/DRAINING`, `16/580`). The fix is
 *   not a stopword list excluding "localhost" and "HTTP" — the shape this PR has paid for four
 *   times already — it is restoring the second signal round 6 established and round 10 discarded:
 *   every extensionless file this repository actually tracks either sits under a directory
 *   (`.githooks/pre-commit`) or carries a leading dot at the root (`.gitignore`); confirmed against
 *   `git ls-files` directly (`grep -v '/'` over the tracked list has exactly one extensionless
 *   entry, `.gitignore`, and it has the dot), not assumed from one example. So the extensionless
 *   branch now requires *either* a directory separator *or* a leading dot with no separator — never
 *   a bare undotted word on the strength of a line number alone. `.gitignore:999999` and
 *   `.definitely-missing:42` both keep matching; `localhost:3000` and `HTTP:404` no longer do.
 *
 *   Second: the content-search window (the code line bullet above) read `readText`'s raw output —
 *   comments and strings included — never `readCode`, the comment/string-stripped view the symbol
 *   search has used since round 2. `` `src/daemon/agentcpd.ts:1420` — `server.close()` `` — a real
 *   citation whose literal text survives only inside a comment 30+ lines from where the actual call
 *   happens (confirmed against the real file: `server.close(` appears once as code, 901 lines away
 *   from that comment, far outside the ±60 window) — passed as ADVISORY, because the raw text still
 *   contained the phrase. This is the check's own original defect (a comment mentioning old code
 *   read as evidence the code survives) reappearing for a quoted snippet instead of a bare symbol,
 *   in the one place that still searched raw text after every other search had already moved to
 *   `readCode`. Fixed by searching `readCode(resolved.path)` instead of `text`: every stripper
 *   blanks a comment or string in place without removing a line, so the window's line arithmetic
 *   above is untouched by the swap.
 *
 *   Third: `looksLikeCode`'s round-10 fourth check — a fenced line ending in `;`, `{`, or `}` reads
 *   as code — was too blunt in the opposite direction, per the same reviewer who suggested it: true
 *   of most English prose, not all of it. Rather than narrow it (excluding a brace-enumeration, say
 *   — a fifth check for a case found today, blind to the next one, the exact shape round 5 already
 *   named and rejected), it is dropped. Checked before dropping it, not assumed safe: neither
 *   authority this script already trusts — `git ls-files` for what is a file, `readCode` for what
 *   is code within a *known* file — answers "is this fenced quote prose or code" at all, because
 *   both questions are about the tracked tree and a citation's quoted text is not in it; verified
 *   directly against #649's own fixture that the prose lines this heuristic protects
 *   ("reconstitution is allowed when no active CEO exists (#619)") do not appear anywhere in the
 *   current file, raw or `readCode`-stripped, so dropping the heuristic entirely (tried first, per
 *   the reviewer's "fewer rules" framing) would reopen the exact false STALE round 8 fixed by
 *   keeping it. The disclosed cost: a fenced bare statement with no distinguishing capitalization
 *   and no boundary immediately after its first word (`return null;` chief among them) is not
 *   recognised as code and stays ADVISORY even when genuinely gone. The same content *inline* is
 *   still caught (round 8's unconditional delimiter trust does not depend on this heuristic at
 *   all); the gap is specific to the fenced branch, where neither "trust the fence" nor "guess at
 *   punctuation" turned out to be a substitute for a real signal.
 *
 *   Corpus diff (fresh snapshot, before/after, every changed line checked against the real issue
 *   text): one removed (`README:89`, #510 — no dot, no slash, the same shape as `localhost`/`HTTP`,
 *   correctly no longer extracted), zero added. Each of the three fixes above was *also* proven by
 *   a constructed counterexample against real tracked files (`.gitignore`, `src/daemon/agentcpd.ts`,
 *   `src/bootstrap/hermes-bootstrap.ts`) rather than relying on the corpus shift alone — necessary,
 *   because the corpus is silent on two of the three findings (nothing open right now pairs a bare
 *   word with a line number the way `localhost:3000` does, and no open fenced citation happens to
 *   quote a bare statement the way `return null;` does), which is itself the lesson of findings one
 *   and three this round: a clean corpus diff proves the corpus does not currently contain the
 *   shape, not that the shape is handled. The second fix's own corpus diff briefly showed a
 *   different citation (#630, `src/runtime/hermes-ceo.ts:341`) flip ADVISORY→STALE before this
 *   paragraph was written — investigating *why*, rather than trusting the flip, is what found round
 *   12's desync bug below; see that section for the corrected, final diff for this fix.
 *
 * ## Round 12: the property the round 11 fix actually needed, not just the one instance a corpus
 * citation happened to expose
 *
 *   Round 11's own closing judgment named the honest limit: the newline-preserving fix to
 *   `stripSlashComments`/`stripSqlComments`/`stripStrings` was verified against the one real corpus
 *   citation that exposed it (#630), not against the *general* claim that every stripper preserves
 *   `text.split("\n").length` for any input — and a corpus diff cannot speak to shapes the corpus
 *   does not currently contain, the same lesson round 11 itself had just learned the hard way.
 *
 *   `blankKeepingNewlines`, `stripSlashComments`, `stripHashComments`, `stripSqlComments`,
 *   `stripStrings`, and `stripTemplateLiteralProse` moved to `./lib/tracker-loci-strip.mjs` — the
 *   same move `collapse-trailer-paragraphs.mjs` made for the same reason — so a test could import
 *   and drive them directly instead of only ever seeing them through whatever one issue's citation
 *   happened to reach. `tests/unit/tracker-loci-strip-invariants.test.ts` asserts the property
 *   itself, every stripper against every adversarial input, not just the pairing each input was
 *   built for: nested template literals, an odd (unbalanced) quote count, an escaped multi-line
 *   string, a `/* ... *\/` spanning many lines, and a `//`/`--`/`#` comment at end of file with no
 *   trailing newline.
 *
 *   Building it found a second, real desync — not the one it was written to confirm.
 *   `stripTemplateLiteralProse`'s escape-sequence branch blanked *every* `\X` pair to two spaces
 *   unconditionally, on the theory that neither character is a symbol reference. True for an
 *   ordinary escape (`\"`, `\\`); false for a template literal's own line-continuation (a backslash
 *   followed by a literal newline, valid JS, the same escape an ordinary string uses) — blanking
 *   that pair to `"  "` ate the newline along with the backslash, shifting every line after it out
 *   of sync with the real file, exactly the class of bug round 11 fixed for the other three
 *   strippers and missed here because nothing in the real corpus at the time happened to cite a
 *   file with this shape in it. Fixed by checking which character was actually escaped: a newline
 *   is re-emitted as a newline; anything else still becomes two blank spaces, unchanged.
 *
 *   Verified both directions on the same fresh corpus snapshot used for round 11's own diff: zero
 *   change. No open issue currently quotes content from a file whose citation window crosses a
 *   template literal with a line-continuation escape in its prose text — the property test, not
 *   the corpus, is what proves this fix and the one before it, the same distinction this round
 *   exists to make concrete rather than merely assert.
 *
 * ## Round 13: the mirror of round 11's own fix, in the other direction
 *
 *   The content-search needle was still built from `citation.content` verbatim — the citation's
 *   *raw* quoted text — while round 11 moved the haystack to `readCode`, which also strips
 *   string-literal content (blanked to same-length spaces, quotes kept). An exact, currently-
 *   correct citation that happens to quote a line containing a string literal read STALE: `` `if
 *   (!row) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });` `` — the real,
 *   unchanged line at `session-registry.ts:148` — failed a literal match against the stripped
 *   haystack on the one span (`"unknown session"`) that was never supposed to compare literally in
 *   the first place, because that span was blanked on one side of the comparison and not the
 *   other. The identical line with the string literal replaced by a bare identifier (no quote at
 *   all) already worked; only the presence of a string in the *quoted citation* broke it, which is
 *   exactly why the round-11 fix and this one are the same shape pointed in opposite directions.
 *
 *   Three options, considered in order of how much they change: strip the needle the same way as
 *   the haystack (symmetric, simplest); search raw text for the needle but require the match to
 *   fall outside a stripped span (keeps the needle raw, but needs the strippers to report span
 *   positions, not just blanked text — a bigger interface change for every stripper); or keep two
 *   haystacks and pick the "appropriate" one per citation (does not actually resolve anything: a
 *   needle that legitimately mixes real code and a string literal has no single "appropriate"
 *   haystack to check whole against). Took the first: `stripToCodeView` — the same per-extension
 *   dispatch `readCode` already used, pulled out so it can run on a string that is not a file's
 *   contents — strips the needle through the identical path before `snippetPattern` builds a regex
 *   from it, so both sides of the comparison agree about what counts as content rather than one
 *   side searching in raw space and the other in stripped space.
 *
 *   Checked before adopting it, not assumed safe: does stripping the needle reopen round 11's
 *   comment case? No — a needle that is *itself* ordinary code (no `//`/`/* *\/`/quote syntax in
 *   the quoted text, `server.close()` among them) strips to itself unchanged, so a citation whose
 *   old code now survives only inside the file's comment still fails to match the comment-stripped
 *   haystack exactly as round 11 intended; verified directly, not inferred. The one case that does
 *   change: a needle that quotes a comment *including its own marker* (`` `// old code:
 *   doSomething()` ``) strips to nothing. `snippetPattern("")` was already `null` elsewhere in this
 *   script for an empty snippet; falling through to ADVISORY — the same treatment a citation with
 *   no quoted content at all already gets — is the defined answer Sol's report asked for, not a
 *   crash and not a silently wrong verdict: an unverifiable quote is not asserted as a fact this
 *   check cannot check.
 *
 *   On the property question: round 11's own invariant (`strip(text)` preserves `text`'s line
 *   count) is a property of *one stripper in isolation* and says nothing about whether *two
 *   applications of stripping, to two different strings, agree with each other* — which is
 *   exactly the class this bug is in. The property that covers this class is different and higher
 *   up: **citing a real, current line verbatim must never read STALE.** `tests/unit/verify-
 *   tracker-loci-resolve.test.ts` now asserts it across three of the four stripped language
 *   families (TypeScript, SQL, shell) against real tracked files, not fenced/inline shapes typed by
 *   hand — the fourth, Python, is deliberately excluded: verifying this property against the one
 *   `.py` file this repository tracks (`deploy/egress/allowlist-proxy.py`) surfaced a *separate*,
 *   real defect — its triple-quoted module docstring desynchronizes `stripStrings`' single-
 *   character quote pairing for everything after it (confirmed directly: `ALLOWLIST_DIGEST`'s own
 *   declaration at line 77 is blanked away in the stripped view, and the existing round-4 positive-
 *   control test for that exact symbol only passes because a second, coincidental occurrence at
 *   line 84 survives the corruption). That is a string-*boundary* defect (triple quotes are not a
 *   single character), not a needle/haystack asymmetry, and reported rather than folded into this
 *   fix — see the round 13 commit message for the fuller account of what was found and why it is
 *   left for its own round.
 *
 * ## Round 14: the two findings a blind review filed against round 13, both instances of this
 * script's own most-repeated defect — a check does not cover what it says it covers
 *
 *   Finding 1 (#700, closed by this round): `stripStrings` pairs a Python triple-quoted string
 *   (`"""..."""`/`'''...'''`) as three independent single-quote delimiters, not one multi-
 *   character one — round 13 named this and deliberately left it for its own round rather than
 *   folding it in. `stripPythonSource` (in `scripts/lib/tracker-loci-strip.mjs`) replaces the
 *   `stripStrings(stripHashComments(text))` pipeline for `.py` specifically with a single
 *   character walk that resolves a `#` and a quote (of either width) in the order a real
 *   tokenizer would — which also fixes a second, smaller desync the two-pass pipeline had: a `#`
 *   *inside* a docstring (this repository's own module docstring names `#419`) was being read as
 *   a comment marker regardless of string context, because `stripHashComments` ran blind to it.
 *   Verified against the real counterexample #700 reported, not a constructed stand-in: quoting
 *   `deploy/egress/allowlist-proxy.py`'s real line 77 (`ALLOWLIST_DIGEST`'s own declaration, the
 *   occurrence the corrupted pairing was eating, not the coincidental one 7 lines later that let
 *   the existing round-4 test pass for the wrong reason) now reads ADVISORY, not STALE. `.sh` and
 *   `.yaml`/`.yml` share `stripHashComments` but not this fix — neither has a triple-quote string
 *   convention to get wrong the same way, confirmed rather than assumed by grepping this
 *   repository's own tracked `.sh` files for one.
 *
 *   Finding 2 (also #700): `stripToCodeView` blanked string content out of *both* the content-
 *   search needle and haystack (round 13's own fix for a different bug — see above), which made
 *   string content entirely incomparable: an elision-tolerant pattern built from a blanked string
 *   collapses to `\s+`, matching any string content of any length at that position. A citation
 *   quoting a line whose string literal had since changed to something else entirely still read
 *   ADVISORY — the check reporting a coverage over string content it was not actually comparing.
 *   Decided deliberately, not left as an implicit tolerance: string content is not the same kind
 *   of thing a comment is (a comment is a sentence *about* code; a string literal *is* content,
 *   the same way an identifier is), so it should compare literally. `stripCommentsForContentView`
 *   is a second per-extension view, used only for the content-search needle and haystack, that
 *   strips comments the same way `stripToCodeView` does but leaves string (and template-literal)
 *   content untouched; `stripToCodeView`/`readCode` are unchanged and still used for symbol
 *   search, which still wants string content blanked (round 3's `utf8` counterexample). Verified
 *   this does not reopen either prior bug it sits beside: round 13's needle/haystack symmetry
 *   (both sides still go through the same function) and round 11's comment-survival fix (comments
 *   are still stripped from both sides here) are both unaffected — only string-content sensitivity
 *   changed, and only in the content-search path.
 *
 * ## Round 15: the third instance of the same bug — the JS/TS stripper was never string-aware to
 * begin with
 *
 *   Round 14 fixed Python's `#`-vs-string ordering (#700, `stripPythonSource`) and split the
 *   content-search view from the symbol-search view. Both call sites for JS/TS still ran
 *   `stripSlashComments` — a regex, line-by-line, comment stripper — *first*, before either view
 *   knew where a string started. A `//` inside a string literal that contains no `://` (the one
 *   shape the old lookbehind protected) read as a real comment and truncated the line, destroying
 *   the string's closing quote before `stripStrings` ever ran.
 *
 *   Confirmed against the real corpus: `tests/integration/pipeline.test.ts` writes
 *   `"module.exports = () => 2; // addressed review\n"` as a string, and `module.exports` appears
 *   *only* inside it. `` `module.exports` in `tests/integration/pipeline.test.ts` `` returned
 *   `stale: []` — the opposite of this script's own rule that a symbol found only inside a string
 *   is STALE — because the corrupted comment-strip left `module.exports = () => 2; ` looking like
 *   an unterminated, unrecognized string that `stripStrings` never paired off and therefore never
 *   blanked.
 *
 *   `stripJsSource` (`scripts/lib/tracker-loci-strip.mjs`) replaces the three-function pipeline
 *   (`stripStrings(stripTemplateLiteralProse(stripSlashComments(text)))` for the symbol view,
 *   `stripSlashComments(text)` alone for the content view) with one ordered character walk, the
 *   same shape as `stripPythonSource`: `//`, `/* ... *\/`, `"`, `'`, and `` ` `` (template
 *   literals, `${…}` expressions walked recursively) are each recognized in the order a real
 *   tokenizer sees them, so a string or template literal is entered before a `//`/`/*` inside it
 *   can be misread, and — the mirror case — a quote inside an already-started comment is just
 *   comment text and never opens a string. The `://` lookbehind is gone; it is no longer needed
 *   once ordering itself is correct. Verified against every delimiter-ordering shape this class of
 *   bug can take (`tests/unit/tracker-loci-strip-invariants.test.ts`): `//` in a string, a quote in
 *   a `//` comment, a quote in a `/* *\/` comment, a `/* *\/` inside a string, a template literal
 *   whose `${…}` contains a quote, an escaped quote, and an unterminated string — each has its own
 *   row, not folded into one broad assertion, the same discipline round 11's property test used.
 *
 * ## Round 16: the fourth instance was pre-filed against this same round — shell and YAML had the
 * identical defect and were shipped anyway
 *
 *   Round 15's own closing note flagged it directly: `.sh`/`.yaml`/`.yml` still ran
 *   `stripStrings(stripHashComments(text))` — the same two-pass, string-blind pipeline round 15
 *   fixed for JS/TS — for both the symbol view and (`stripHashComments` alone) the content view.
 *   Shipping that unfixed under a commit claiming the stripper now resolves things in one ordered
 *   walk would have been true for two of the four languages this script handles and false for the
 *   other two.
 *
 *   Confirmed against the real corpus, worse than the JS/TS instance: `deploy/install-launchd.sh`
 *   line 173 writes `printf '#!/bin/bash\nset -euo pipefail\n'`. The old `stripHashComments` ran
 *   first, blind to the string boundary; the `#` right after the opening `'` (preceded by `'`, not
 *   `:` — the old regex's only guard) started a "comment" that ate the rest of the line, including
 *   the string's own closing `'`. `stripStrings`'s single-quote regex then paired that surviving
 *   lone `'` with the *next* `'` anywhere later in the file — the opening quote of the following
 *   line's own `printf '...'` — desynchronizing every quote pairing after it for the rest of the
 *   file, not just one string. `required_keychain_value` (declared line 191, called lines 249 and
 *   250 — three real, current occurrences) survived zero of them in the old stripped view.
 *
 *   `stripShellSource`/`stripYamlSource` (`scripts/lib/tracker-loci-strip.mjs`) give each language
 *   its own ordered walk rather than reusing one generic pipeline for both — their quoting rules
 *   differ too much to share one (shell's plain `'...'` has no escape character at all; YAML's
 *   `'...'` escapes a literal quote by doubling it; shell alone has `$'...'` and heredocs). Both
 *   add a `#` word-boundary rule (comment only at start-of-line or after whitespace) that neither
 *   old pass implemented, which also fixes — as a side effect of the rule being right, not a
 *   special case — three shapes this repository's own tracked `.sh` file already contains: `$#`,
 *   `${x##suffix}`, and `8#22` (arithmetic base notation). A heredoc body is walked verbatim
 *   (never comment- or string-scanned), so a `#` inside one — this file's own two heredocs, an
 *   embedded second script — is not mistaken for a comment of the outer file. What cannot be
 *   resolved statically is disclosed rather than silently scored: a YAML block scalar (`|`/`>`) is
 *   walked as ordinary text, not full indentation-tracked; a quoted heredoc word with characters
 *   outside `[A-Za-z0-9_]` is not recognized — neither shape appears in this repository's own
 *   tracked files, confirmed by grep rather than assumed.
 *
 *   SQL (`stripStrings(stripSqlComments(text))`) had the same latent shape and was not touched in
 *   this round — named, not fixed, and sent back for exactly that reason. See round 17.
 *
 * ## Round 17: the fifth instance — SQL, disclosed at the end of round 16 and fixed here
 *
 *   Every extension dispatch in this script, enumerated rather than recalled from memory (there
 *   are exactly five — `JS_FAMILY_EXTS`, `PY_EXTS`, `SH_EXTS`, `YAML_EXTS`, `SQL_EXTS` — everything
 *   else falls through to a plain-text search, disclosed as such by `codeSearchScope`'s own final
 *   branch): JS/TS, Python, shell, and YAML each now run one ordered character walk (rounds 14–16).
 *   SQL alone still ran `stripStrings(stripSqlComments(text))` for the symbol view and
 *   `stripSqlComments(text)` alone for the content view — the same two-pass, comment-blind-to-
 *   strings pipeline every prior round fixed for its own language, still present here because
 *   round 16's own closing note named it and stopped.
 *
 *   Measured against this repository's own tracked SQL before fixing it, not assumed broken by
 *   analogy: neither `src/db/schema.sql` nor `tests/fixtures/schema-v11.sql` contains a `--` or
 *   `/* *\/` literally inside a `'...'` string (verified with a proper quote-aware walk — a naive
 *   regex check falsely "finds" several, every one of them an English possessive apostrophe inside
 *   a `--` comment pairing with a real string quote many lines later, exactly the trap round 16's
 *   own YAML corpus check had to walk past). The old pipeline and the new `stripSqlSource` produce
 *   byte-identical output for both real files, in both views — this defect had no live corpus
 *   instance in this repository's SQL, unlike the shell one. That is a fact about this corpus, not
 *   a reason the fix was unnecessary: the pipeline was exactly as blind to string boundaries as the
 *   shell one was, and a RED test built from a constructed instance of the same shape (a `--`
 *   inside a `'...'` string desynchronizing a later real symbol, `tests/unit/tracker-loci-strip-
 *   invariants.test.ts`) failed against the old pipeline and passes against the new one.
 *
 *   `stripSqlSource` (`scripts/lib/tracker-loci-strip.mjs`) gives SQL the same single ordered walk:
 *   `--` starts a comment unconditionally (unlike shell's `#`, SQL's `--` has no other meaning, so
 *   there is no word-boundary rule needed); `/* *\/` does not nest, confirmed against SQLite's own
 *   documented behavior (this repository's actual engine, via `better-sqlite3`); a `'...'` value
 *   string escapes its own delimiter by *doubling* it, not backslash — a real semantic correction
 *   from `stripStrings`'s backslash-based regex, standard SQL and SQLite both treat `\` as a
 *   literal character in a string; `"..."`/`` `...` ``/`[...]` are *identifier* quoting, not value
 *   quoting, so unlike `'...'` they are recognized as atomic spans but never blanked in either view
 *   — a quoted column or table name is a real reference the same way a bareword identifier is. The
 *   mirror case holds the same way it does for every other language here: a quote inside a `--` or
 *   `/* *\/` comment is just comment text and never opens a string or identifier. Dollar-quoting
 *   (PostgreSQL's `$tag$...$tag$`) is disclosed as unimplemented, not silently scored: this
 *   repository's SQLite schema has no dollar-quoted string anywhere, and SQLite itself does not
 *   support the feature, so there is nothing in this corpus or this engine to verify it against.
 *
 *   All five dispatches now run one ordered walk each. None remains on the old two-pass shape.
 *
 * ## Round 18: the sixth instance — this file's own report text claimed an exclusion shell's
 * stripper does not perform, and shell's `#` word-boundary rule was itself still too narrow
 *
 *   A blind review reproduced a false green through the real production CLI, not a constructed
 *   case: `` `CODEX_HOME` in `deploy/install-launchd.sh` `` returned exit 0 with empty findings.
 *   `CODEX_HOME` appears exactly once in that file, at line 268 — inside a `#` comment, itself
 *   inside the heredoc `deploy/install-launchd.sh:187-287` writes as an embedded launcher script.
 *   Round 16's `stripShellSource` passed a heredoc body through fully verbatim, on purpose (a
 *   heredoc's content is "genuinely part of what the file contains," per that round's own
 *   comment) — but round 16's `codeSearchScope` sentence, above, also claimed a heredoc body was
 *   *excluded* from the symbol search, which was never true even before this round: real code
 *   inside a heredoc body (`required_keychain_value`, the same round's own corpus example) has
 *   always counted as found, not excluded. Two different bugs, sharing one root: the report
 *   sentence and the stripper's actual behavior were never checked against each other as one
 *   claim.
 *
 *   The resolution keeps "search the heredoc verbatim" and "a comment inside a heredoc is not
 *   code" both true, rather than picking one: `consumeHeredocBody`
 *   (`scripts/lib/tracker-loci-strip.mjs`) now recurses into the body with `stripShellSource(...,
 *   false)` — `blankStrings: false` is forced regardless of the outer call's own view, which,
 *   because a `#` comment is stripped unconditionally in this same function's dispatch (`#` is
 *   never gated on `blankStrings`), strips only the body's own comments and leaves every quoted
 *   string's content exactly as it was in both views. Narrower than treating the whole body as
 *   code of its content language: `required_keychain_value`'s own call site inside the same
 *   heredoc reaches it through `"$(required_keychain_value …)"`, a command substitution inside a
 *   double-quoted string — real code, not string prose — and forcing `blankStrings: true` into the
 *   recursive call would have blanked that call out of the symbol view, trading one false green
 *   for a false negative on a real, currently-passing corpus assertion
 *   (`tests/unit/tracker-loci-strip-invariants.test.ts`'s `required_keychain_value` row, which
 *   still asserts all three real occurrences survive both views). `codeSearchScope`'s SH_EXTS
 *   sentence, above, is rewritten to say exactly this: a `#` comment excludes at a word boundary
 *   including inside a heredoc body, a quoted string excludes outside one, and a heredoc body's
 *   own quoted-string content does not.
 *
 *   The same review flagged shell's `#` word-boundary rule (round 16: comment only at
 *   start-of-line or after whitespace) as narrower than real shell grammar: `;# comment` and
 *   `|# comment` both open real comments (a new word starts right after a control operator, not
 *   only after whitespace), and the old rule read the `#` in both as plain text. Neither shape
 *   appears in this repository's own tracked `.sh` files or `.github/workflows/*.yml` today
 *   (confirmed by grep, not assumed) — this closes a latent gap rather than a live corpus
 *   citation, but per this same file's own standard for `$#`/`${x##suffix}`/`8#22` two rounds
 *   ago, the rule should be right regardless of whether the corpus happens to exercise every
 *   shape of it yet. `isWordBoundaryBefore` (`scripts/lib/tracker-loci-strip.mjs`) now also treats
 *   `;`, `|`, `&`, `(`, and `)` as word boundaries — checking only the immediately preceding
 *   character is enough to cover `;;`/`&&`/`||` too, since a repeated operator character still
 *   ends with the same character right before the `#`.
 *
 * Usage: node scripts/verify-tracker-loci-resolve.mjs [--json] [--strict] [--issues-file=<path>] [--repo-root=<path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripJsSource,
  stripPythonSource,
  stripShellSource,
  stripSqlSource,
  stripYamlSource,
} from "./lib/tracker-loci-strip.mjs";

const defaultRepoRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(
  process.cwd(),
  process.argv.find((a) => a.startsWith("--repo-root="))?.slice("--repo-root=".length) ?? defaultRepoRoot,
);
const asJson = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const issuesFile = process.argv.find((a) => a.startsWith("--issues-file="))?.slice("--issues-file=".length);

const listIssues = () => {
  if (issuesFile) return JSON.parse(readFileSync(resolve(repoRoot, issuesFile), "utf8"));
  try {
    // `gh issue list --limit 500` is a hard ceiling, not a completeness check. `gh api
    // --paginate --slurp` follows every Link page and returns an array for each page. The REST
    // `/issues` endpoint also includes pull requests, unlike `gh issue list`, so discard those
    // before checking citations.
    const pages = JSON.parse(
      execFileSync(
        "gh",
        ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues?state=open&per_page=100"],
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new Error("GitHub pagination did not return an array of issue pages");
    }
    return pages.flat().filter((issue) => !issue.pull_request);
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

const issues = listIssues();

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
 * `blankKeepingNewlines`, `stripSlashComments`, `stripHashComments`, `stripSqlComments`,
 * `stripStrings`, and `stripTemplateLiteralProse` live in `./lib/tracker-loci-strip.mjs` now,
 * not here — round 12 moved them so a property test could import them directly (see that
 * file's own docstring for why, and `tests/unit/tracker-loci-strip-invariants.test.ts` for the
 * property itself: every one of them has to preserve `text.split("\n").length`, because their
 * output is sliced by line number downstream, not only searched as a whole).
 */

/**
 * What "does not appear as code" means, per language — see the round-4 note beside this
 * function's callers for why this is stated explicitly rather than left implicit. Only the
 * extensions listed here get a comment/string-aware search; everything else is disclosed as a
 * plain text search with no exclusions, rather than silently applying JavaScript's rules to a
 * file that does not use them.
 */
const JS_FAMILY_EXTS = new Set(["ts", "tsx", "js", "mjs", "cjs", "mts"]);
const SQL_EXTS = new Set(["sql"]);
// Python, shell, and YAML each get their own dedicated stripper (`stripPythonSource`,
// `stripShellSource`, `stripYamlSource`) — none of the three share a generic
// `stripStrings(stripHashComments(text))` pipeline any more (round 14 for Python, round 16 for
// shell/YAML — see both below). Each language's `#`-vs-quote-vs-comment ordering and quoting rules
// differ enough (Python's triple quotes, shell's `#` word-boundary rule plus heredocs and
// `$'...'`, YAML's doubled-`''` escape) that a shared pipeline kept re-introducing the same
// ordering defect for whichever language did not get its own walk yet.
const PY_EXTS = new Set(["py"]);
const SH_EXTS = new Set(["sh"]);
const YAML_EXTS = new Set(["yaml", "yml"]);

const extensionOf = (relPath) => {
  const dot = relPath.lastIndexOf(".");
  return dot === -1 ? "" : relPath.slice(dot + 1).toLowerCase();
};

/** A short, human-readable name for what a symbol search excludes in this file's language. */
const codeSearchScope = (relPath) => {
  const ext = extensionOf(relPath);
  if (JS_FAMILY_EXTS.has(ext)) return "outside a `//`/`/* */` comment, a quoted string, or template-literal prose";
  if (PY_EXTS.has(ext)) return "outside a `#` comment or quoted string";
  if (SH_EXTS.has(ext))
    return (
      "outside a `#` comment (at a word boundary — this applies inside a heredoc body too) or a " +
      "quoted string (a heredoc body's own quoted-string content is not excluded; it is searched " +
      "as the code it contains)"
    );
  if (YAML_EXTS.has(ext)) return "outside a `#` comment (at a word boundary) or a quoted scalar";
  if (SQL_EXTS.has(ext)) return "outside a `--`/`/* */` comment or a quoted string (a quoted identifier is code)";
  return `as plain text (no comment or string exclusion applies to .${ext} files)`;
};

/**
 * The per-extension comment/string-stripping dispatch itself, pulled out of `readCode` so the
 * same transform can run on a string that is not a file's contents — see round 13's fix to the
 * content-search needle, below, for why that is needed at all.
 *
 * This is the *symbol-search* view: both comments and string content are excluded, so a symbol
 * name that only happens to be spelled inside a string literal does not count as the file
 * declaring it (round 3's `utf8` counterexample). Round 14 splits this from the *content-search*
 * view (`stripCommentsForContentView`, below) — see that function's comment for why the two need
 * different answers about string content, #700 for the Python-specific fix here, and round 16 for
 * the shell/YAML one.
 */
const stripToCodeView = (text, ext) => {
  if (JS_FAMILY_EXTS.has(ext)) return stripJsSource(text, true);
  if (PY_EXTS.has(ext)) return stripPythonSource(text, true);
  if (SH_EXTS.has(ext)) return stripShellSource(text, true);
  if (YAML_EXTS.has(ext)) return stripYamlSource(text, true);
  if (SQL_EXTS.has(ext)) return stripSqlSource(text, true);
  return text; // no supported comment syntax for this extension — see codeSearchScope
};

const codeTextCache = new Map();
const readCode = (relPath) => {
  if (!codeTextCache.has(relPath)) {
    codeTextCache.set(relPath, stripToCodeView(readText(relPath), extensionOf(relPath)));
  }
  return codeTextCache.get(relPath);
};

/**
 * ## Round 14: #700's finding 2 — string-insensitive comparison is a hole, not a tolerance
 *
 * Round 13 made the content-search needle and haystack agree by stripping *both* through
 * `stripToCodeView` — the symbol-search view, which blanks string content on both sides. That
 * fixed the needle/haystack asymmetry it was written for, but it went further than the fix
 * needed: blanking a string's content to same-length spaces and then building an elision-tolerant
 * regex from it (`snippetPattern` collapses any run of blanked spaces to `\s+`) makes the regex
 * match *any* string content of *any* length at that position, not just the one the citation
 * actually quoted. A citation of `` `session-registry.ts:148` — `deny(ReasonCode.NOT_FOUND,
 * "unknown session", { sessionId })` `` would keep reading ADVISORY even if the real string were
 * rewritten to `"completely different text"` — the check reporting coverage over string content
 * it is not actually comparing, silently.
 *
 * Comments and string content are not the same kind of thing here. A comment mentioning deleted
 * code is a sentence *about* code, not code (round 11's whole argument for stripping comments from
 * the content-search haystack); a string literal is not a description of the line, it *is* the
 * line's content, the same way a bare identifier is. Blanking comments out of the comparison is
 * correct; blanking strings out of it erases exactly the content a citation quoting a string is
 * making a claim about.
 *
 * Decision: the content-search view strips comments only, on both the needle and the haystack, and
 * leaves string (and template-literal) content untouched. This is a *separate* view from
 * `stripToCodeView` — the symbol search still wants strings blanked, for the reason above — so
 * this is not a change to `stripToCodeView` itself, but a second per-extension dispatch used only
 * by the content-search needle/haystack comparison.
 *
 * Checked before adopting it: does this reopen round 13's own bug (needle raw, haystack stripped,
 * asymmetric)? No — both sides go through this same function now, so they still agree with each
 * other; what changed is which things count as "content" (strings do, comments still do not), not
 * whether the two sides are compared symmetrically. Does it reopen round 11's comment-survival
 * fix? No — comments are still stripped here exactly as `stripToCodeView` strips them; only string
 * content differs between the two views.
 */
const stripCommentsForContentView = (text, ext) => {
  if (JS_FAMILY_EXTS.has(ext)) return stripJsSource(text, false);
  if (PY_EXTS.has(ext)) return stripPythonSource(text, false);
  if (SH_EXTS.has(ext)) return stripShellSource(text, false);
  if (YAML_EXTS.has(ext)) return stripYamlSource(text, false);
  if (SQL_EXTS.has(ext)) return stripSqlSource(text, false);
  return text;
};

const contentViewCache = new Map();
const readContentView = (relPath) => {
  if (!contentViewCache.has(relPath)) {
    contentViewCache.set(relPath, stripCommentsForContentView(readText(relPath), extensionOf(relPath)));
  }
  return contentViewCache.get(relPath);
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
 * Every extension this repository's own tracked tree actually uses, lowercased — `trackedFiles`
 * turned into the set of what is structurally plausible as a *file* extension, rather than a
 * hand-maintained list of ones. Needed for exactly one thing: a backtick- or quote-delimited bare
 * mention (see `isExplicitlyDelimited`, below) is extracted as a citation candidate the same way a
 * real path is, but "delimited" alone does not tell a real filename apart from a SQL column or a
 * `Class.method` reference the issue author also, and just as legitimately, wrote in backticks —
 * `` `inbound_messages.turn_claim_json` `` and `` `ConversationTurnCoordinator.claim` `` both
 * cleared every other gate once the delimiter one was added, and neither is a path at all.
 * Requiring the dotted suffix to be an extension this repository's tree actually has is the same
 * git-ls-files-is-the-authority move round 6 already made generally for "any .word" extensions:
 * "turn_claim_json", "claim", "actor_id", "pollOnce", "os_pid", and "merge_order" are none of them
 * extensions anything here is tracked under, while "md", "py", and "js" all are — measured against
 * the real corpus before trusting this (round 9 commit), not guessed at; every false positive this
 * gate removes was a real citation in a real open issue, not a constructed case. It also excludes
 * a genuine but untracked runtime artifact bare-cited the same way (`` `state.db` ``, `.hermes/`'s
 * own — "db" is not an extension anything committed here uses), which is the correct side to fall
 * on: a check over the *tracked* tree has no basis to call a live, deliberately gitignored file
 * "missing" just because git does not carry it.
 */
const knownExtensions = new Set(trackedFiles.map((f) => extensionOf(f)).filter(Boolean));

/**
 * Every local branch, remote-tracking branch, and tag this repository knows about — the authority
 * for where a GitHub blob permalink's `<ref>` ends, independent of whether the file it cites still
 * exists. That independence is the reason this exists rather than reusing `trackedFiles` for the
 * ref/path split too: a permalink citing a *genuinely deleted* file can never resolve against
 * tracked files at any split point, by definition, so a design that only trusts a split when the
 * resulting path exists cannot ever report that file gone — the one case this whole check is for.
 *
 * A remote-tracking branch's short name (`origin/main`) is indexed with the leading remote segment
 * stripped too (`main`), because a GitHub URL never spells the remote out.
 */
const knownRefs = (() => {
  try {
    const raw = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const refs = new Set();
    for (const line of raw.split("\n")) {
      const ref = line.trim();
      if (!ref) continue;
      refs.add(ref);
      const slash = ref.indexOf("/");
      if (slash !== -1) refs.add(ref.slice(slash + 1));
    }
    return refs;
  } catch {
    return new Set();
  }
})();

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
// Round 6: this used to be a hand-maintained list of specific extensions (`tsx|ts|mts|mjs|cjs|
// json|js|plist|py|sh|sql|md|yaml|yml`) — evidence-first (each one added because a real issue
// cited it), but still a list, and a fourth counterexample found the shape again: a real tracked
// file (`tests/fixtures/buzz-cli/cli-version.txt`) went unrecognized because `.txt` was never
// added, while `Node.js` — a product name, not a path — matched because `.js` was.
//
// `git ls-files` is the authority on what is a file here, and the script already uses it
// (`trackedFiles`, `resolvePath`) for resolution — a hand-maintained extension list was standing
// in front of that authority rather than deferring to it. So the extension is now generic (any
// `.word`, not an enumerated set): what makes a bare mention a candidate worth resolving at all is
// no longer "is this a known extension" but the same move as round 5's quoted/unquoted split —
// **does the text carry a signal specific enough to not be an ordinary word that happens to
// contain a dot.** A path with a directory separator (`deploy/egress/allowlist-proxy.py`) is that
// signal; so is an explicit line number (`README.md:1`, `Node.js:12` — the number makes even a
// bare name a citation, not a product mention). A bare, directory-free name with no line number
// (`Node.js`, `React.js`) is exactly as ambiguous as `Node.js` and `HANDOFF-CEO-RESUME.md` are to
// each other with no other context — both are "Capitalized-Word.ext" — so it is not extracted as
// a citation at all, the same way round 5 stopped guessing at unquoted prose rather than refining
// the guess. Measured against every open issue (see the round 6 docstring note): this drops five
// previously-flagged bare mentions (`CLAUDE.md`, `AGENTS.md`, `SSOT.md`, `ARCHITECTURE.md`,
// `HANDOFF-CEO-RESUME.md`) and adds none — a real cost, reported rather than hidden, in exchange
// for deleting a category of false STALE this check cannot actually tell apart from a real one
// without a directory or a line number to anchor it.
// Round 7: "`git ls-files` is the authority" was not true yet — an extension requirement still
// sat in front of it. `.githooks/pre-commit` (real, tracked, no extension at all) was invisible
// regardless of what it resolved to, and a leading dot on any path (`.github/workflows/ci.yml`)
// was dropped by the `\b` boundary before the character class ever got to see it — `\b` requires
// a word/non-word transition, and "." next to whitespace is non-word on both sides, so the match
// silently started one character late and read `.github/…` as `github/…`. That produced a real,
// published false finding: a "missing leading dot" the checker itself had manufactured by
// dropping the dot from a citation that had it correctly.
//
// Fixed with two independent changes, not one that happens to cover both:
//   - `(?<![\w.])` replaces the leading `\b` — a lookbehind that only cares whether the character
//     before the match is a word character or another dot, so a dot preceded by whitespace (or
//     start of string) is included in the match rather than skipped past.
//   - An extensionless path is recognised *only when a line number immediately follows it*
//     (`(?=:\d|#L\d)`, a zero-width lookahead — the number is still captured normally afterward).
//     The first version of this fix dropped the extension requirement outright for anything with
//     a "/" in it, on the theory that a directory separator alone was signal enough. Measured
//     against every open issue before trusting that: 46 new "citations", nearly all of them
//     nothing to do with a file — GitHub route fragments (`/repos/:o/:r/check-runs/:id` reads as
//     `r/check-runs`), state-pair notation (`READY/DRAINING`, `pending/failed`), directories with
//     no filename (`src/github`), and the digit/digit fractions and counts a plain directory
//     check does not rule out either (`16/580`, `22/22`). A directory separator is not, on its
//     own, specific enough — a line number is, the same way it already is for the *with-extension*
//     case below, and requiring it for the extensionless case too is what actually distinguishes
//     `.githooks/pre-commit:999999` from `src/github` rather than merely hoping to.
// The first segment still has to start with a letter or underscore (never a bare digit) in both
// branches, for the same digit/digit reason. Every real path in this repository's own tree starts
// with a letter or a dot, so this costs nothing real.
//
// Round 10: the extensionless branch still required a directory separator on top of the line
// number — `.gitignore:999999` (real, tracked, no extension, no directory: it lives at the repo
// root) and `.definitely-missing:42` (does not exist) both matched nothing, silently, because
// `(?:/[\w.-]+)+` demanded at least one `/segment`. That requirement was round 6's own
// disambiguator for a *bare mention with nothing else to anchor it* — right there, because
// `src/github` alone is no more a citation than `Node.js` alone is. It was never the reason a
// *line-numbered* extensionless path was accepted; the line number already was, the same way it
// already is for the with-extension branch. Round 10 loosened the directory requirement to zero-
// or-more for *any* bare word, on the theory that a line number alone was signal enough.
//
// Round 11: that theory was wrong, and a real corpus diff would not have shown it — the round 10
// corpus at the time simply did not contain the shape. `localhost:3000` and `HTTP:404` both
// matched and both reported STALE ("localhost does not exist"): a line number distinguishes a
// *file* citation from a *bare product mention* only when there is nothing else competing for
// the same shape, and `word:number` is also how a port, a status code, or a ratio is written —
// shapes round 7's own corpus measurement already found in abundance (`READY/DRAINING`,
// `16/580`) once the directory requirement was dropped for a related reason. The fix is not a
// finer version of the same rule (a stopword list of "localhost", "HTTP", … is the shape this PR
// has already paid for four times); it is restoring the second signal round 6 established:
// `.githooks/pre-commit` and `.gitignore` are recognisable *as paths* not because of the line
// number but because of what git already knows a real file looks like here — every extensionless
// file this repository tracks either sits under a directory (`.githooks/pre-commit`) or carries a
// leading dot at the root (`.gitignore`); nothing tracked is a bare, undotted word (confirmed
// against `git ls-files` directly, not assumed). So the extensionless branch now requires *either*
// a directory separator (unchanged from round 7) *or* a leading dot with no separator (round 10's
// actual target, kept) — never a bare word on the strength of a line number alone. `localhost` and
// `HTTP` have neither and are excluded; `.gitignore` and `.definitely-missing` both have the dot.
const PATH_RE = new RegExp(
  `(?<![\\w.])(\\.?[A-Za-z_][\\w-]*(?:/[\\w.-]+)+(?=:\\d|#L\\d)|\\.[A-Za-z_][\\w-]*(?=:\\d|#L\\d)|\\.?[A-Za-z_][\\w-]*(?:/[\\w.-]+)*\\.[A-Za-z][\\w]*)\\b` +
    `(?::(?<cs>\\d+)(?:-(?<ce>\\d+))?|#L(?<as>\\d+)(?:-L?(?<ae>\\d+))?)?`,
  "g",
);
const URL_RE = /https?:\/\/\S+/g;
// A GitHub blob permalink, parsed structurally rather than through the generic PATH_RE run over
// its raw text. Letting the generic regex loose inside a URL was the earlier bug: it greedily
// matched a fragment of the URL itself (`com/<owner>/<repo>/blob/main/README.md`), not the path
// the link actually names, and reported that fragment ambiguous against every tracked README.
//
// Round 8: two more bugs in this same structural parse, both fixed here.
//
// The path group excluded whitespace, `#`, and `)` but not a backtick — the ordinary way people
// actually write a link in an issue body. `` `https://github.com/…/blob/main/README.md` `` (no
// `#L` anchor to stop the match early at `#`) captured the closing backtick as part of the path,
// and `README.md\`` does not exist. Fixed by excluding backtick from every capture group here.
//
// `/blob/<ref>/<path>` was parsed on the assumption `<ref>` is exactly one segment — true for
// `main`, false for this repository's own branches, which are the whole reason it matters:
// `feat/597-tracker-loci-resolve-or-the-check-says-so` has a slash in it. A URL built from that
// branch name read as `<ref>` = `feat` and `<path>` = `597-tracker-loci-resolve-…/README.md`, a
// file that has never existed. There is no purely syntactic way to know where a multi-segment ref
// ends and the path begins — GitHub itself only knows because it holds the branch list — so this
// group now captures the *whole* ref-and-path span, and `resolveBlobRefAndPath` (below) tries
// splits against `knownRefs` and `trackedFiles`, the same two authorities this script already
// defers to elsewhere.
const GITHUB_BLOB_RE = /https:\/\/github\.com\/([^/\s`]+)\/([^/\s`]+)\/blob\/([^\s#`)]+)(?:#L(\d+)(?:-L?(\d+))?)?/g;

/**
 * Splits a permalink's `<ref>/<path>` span into the branch/tag it names and the file within it,
 * three ways, most authoritative first:
 *
 *   1. The longest known ref (`knownRefs`) that is a prefix of the span, ending on a `/`. Longest
 *      first because a real ref can itself be a segment-prefix of another — this repository has
 *      `origin/feat/597-tracker-loci-resolve` alongside the longer local branch this fix was
 *      written on, and matching short-to-long would stop at the wrong one.
 *   2. Failing that (a fork's branch, a deleted branch, or a checkout where `git for-each-ref`
 *      does not show it), the shortest split whose tail is an *exactly* tracked file — `main`,
 *      the common case, needs nothing more than this.
 *   3. Failing that too, the plain one-segment assumption (`main`-shaped), because a permalink to
 *      a genuinely deleted file can never satisfy step 2 by definition — that file will not
 *      exactly-match anything at any split — and refusing to guess at all here would make this
 *      script unable to ever report the one thing it exists to report: a citation of something
 *      that is gone. An earlier version of this function returned `null` when nothing resolved
 *      exactly, on the theory that a wrong guess is worse than silence; measured against its own
 *      test suite, that theory cost exactly the case it was trying to protect — a multi-segment
 *      ref to a deleted file went silent instead of STALE, because "deleted" and "unresolvable
 *      split" are the same observation from `trackedFiles` alone. Step 1 is what makes step 3 safe
 *      to fall back to: a real branch name, verified independently of whether its file still
 *      exists, is what step 3 lacked, and it did not need it if it never had to run.
 */
const resolveBlobRefAndPath = (refAndPath) => {
  const segments = refAndPath.replace(/[.,;:)]+$/, "").split("/");
  for (let i = segments.length - 1; i >= 1; i--) {
    if (knownRefs.has(segments.slice(0, i).join("/"))) return segments.slice(i).join("/");
  }
  for (let i = 1; i < segments.length; i++) {
    const candidate = segments.slice(i).join("/");
    if (trackedFiles.includes(candidate)) return candidate;
  }
  return segments.length > 1 ? segments.slice(1).join("/") : null;
};
// A symbol may be cited as `name` or `name()` — the parens are the citer marking it a function or
// method, not literal text to search for (a call site rarely has empty arguments); the extraction
// below captures the identifier alone and drops them, the same way `snippetPattern`'s elision
// treats an empty `()` as "a call, arguments omitted" rather than a literal empty parameter list.
// A leading `#` (round 7) is JavaScript's own private-field/method sigil, not decoration to strip —
// `#observe` and `observe` name two different things, and this codebase declares private members
// heavily (`turn-coordinator.ts`'s `#observe` among them), so the symbol pattern allows it directly.
const SYMBOL_ROW_RE = /`([\w./-]+\.\w+)`\s*(?:—|--?)\s*((?:`#?[\w.$]+(?:\(\))?`,?\s*)+)/g;
// A symbol may also be cited the ordinary way people write English about code rather than the
// repo's own table convention — reversed order, `` `symbol` in `path` `` instead of `` `path` —
// `symbol` ``. This is not the keyword scan of unquoted prose round 5 ruled out: both spans here
// are already backtick-delimited, the same explicit-quoting signal the table form itself relies
// on, and "in" is the connector word in place of "—" rather than a guess about what looks like
// code. Measured against the real corpus before trusting it, the same way every extraction change
// in this file has been: two real citations matched (`resolveEscalation` in
// `src/ceo/production-gate.ts`, `completeReplyAndResolveTurn` in `src/ingress/ingress-guard.ts`),
// both genuine, zero incidental matches on anything else in the corpus at the time of that
// snapshot — see the round 9 commit for the full diff.
const SYMBOL_PROSE_RE = /`(#?[\w.$]+)(?:\(\))?`\s+in\s+`([\w./-]+\.\w+)`/g;
const NON_DURABLE_RE = /(\/private\/tmp\/[^\s`)]+|(?<![\w/])\/tmp\/[^\s`)]+)/g;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A word-boundary search pattern for a cited symbol — except `\b` does not work in front of `#`.
 * `\b` is a transition between a word character and a non-word one, and `#` is non-word on both
 * sides in the shape this actually appears (`this.#observe(`, or `#observe(...) {` at the start of
 * a declaration): the character before it is `.`, `{`, or whitespace, all non-word, so `\b#observe`
 * never matches anywhere a private field is genuinely declared or called. A negative lookbehind
 * for a word character or another `#` does the same job `\b` does for an ordinary identifier —
 * refuses a match in the middle of a longer name — without requiring a boundary `#` cannot have.
 */
const symbolPattern = (symbol) => {
  const escaped = escapeRegex(symbol);
  return symbol.startsWith("#")
    ? new RegExp(`(?<![\\w#])${escaped}\\b`)
    : new RegExp(`\\b${escaped}\\b`);
};

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

/**
 * Strips the citation's own closing delimiter and the markdown separator between a citation and
 * whatever follows it — whitespace, a dash, a colon. Shared by both the fenced and inline paths:
 * a fenced line still has the citation's own trailing backtick to remove if it was written
 * `` `path:line` `` inside the fence, and both need the separator dropped before looking at what
 * comes next.
 */
const stripCitationSeparator = (text) => {
  let t = text.replace(/←.*$/, "").trimEnd();
  t = t.replace(/^\s*[`'"]/, ""); // the citation's own closing delimiter, if it had one
  t = t.replace(/^[\s:—–-]+/, ""); // the separator between a citation and what follows
  return t;
};

/**
 * Whether a match is wrapped in an explicit backtick or quote pair — the delimiter sitting right
 * before the match starts and the identical one right after it ends. This is a different question
 * from `readDelimitedSpan`'s (that reads content *after* a citation; this asks about the citation
 * itself), but the same decisive-delimiter reasoning round 5 already established for inline
 * content applies here too: a bare mention with no directory and no line number is exactly as
 * ambiguous as "Node.js" is against a real citation like "HANDOFF-CEO-RESUME.md" (round 6) —
 * *unless* the author set it apart with backticks or quotes, which is the same deliberate act of
 * quoting that already makes an inline citation's trailing content decisive rather than guessed
 * at. Not asking "does this look like a path" (a heuristic); asking "did the author mark this",
 * which is a fact about the text, not a guess about its shape.
 */
const isExplicitlyDelimited = (line, matchStart, matchEnd) => {
  const before = line[matchStart - 1];
  return (before === "`" || before === '"' || before === "'") && line[matchEnd] === before;
};

/**
 * Reads an *explicitly* quoted span from the start of already-separator-stripped text — a
 * backtick or quote mark, up to its matching close — or returns `null` if there is none. Used
 * only for an inline citation's trailing text, which is otherwise an ordinary sentence: without
 * an explicit delimiter there is no fact to check here, only a guess about whether the citer
 * meant to quote something, and guessing is exactly what let ordinary prose ("This describes the
 * banner text and its return value has changed") be read as a stale quote of code that was never
 * there. A citation with no such delimiter gets `null`, unconditionally — not "probably not code",
 * not checked at all.
 */
const readDelimitedSpan = (text) => {
  for (const quote of ["`", '"', "'"]) {
    if (text.startsWith(quote)) {
      const closing = text.indexOf(quote, 1);
      return (closing === -1 ? text.slice(1) : text.slice(1, closing)).trim();
    }
  }
  return null;
};

/**
 * Whether text that is *already known to be quoted* — an explicit inline span, or the rest of a
 * fenced citation's line, where the fence itself is the quotation mark — reads as code rather than
 * as a description of code. This is never asked about unquoted prose; see `readDelimitedSpan` and
 * the fenced branch below for where that line is drawn.
 *
 * Not a keyword list. Three rounds of tuning one (`const`/`let`/… added, then `interface`/`type`/
 * `enum`/`def`/`CREATE` found still missing, while `this`/`return` — ordinary English words that
 * are also JS keywords — separately let ordinary sentences through) proved the shape of the
 * problem: any finite enumeration of "words that mean code" is both too narrow for a form nobody
 * added yet and too wide for the same words used as English. So this asks two questions that do
 * not name a single keyword:
 *
 *   1. Does a mixed-case identifier appear in the first few words — `actorId`, `mintActor`,
 *      `DefinitelyGone`, `ALLOWLIST_DIGEST`? English does not capitalize mid-word or write
 *      multi-word names with no spaces; every language this check reads does, for exactly the
 *      names it declares or references. This alone recognises `interface DefinitelyGone {`
 *      without a list ever having heard of `interface`.
 *   2. Within up to three leading words (enough for `CREATE TABLE Name`, `const actorId =`,
 *      `interface DefinitelyGone {`), does the text right after them open with a call, a member
 *      access, an assignment, or a block? Each is a structural boundary, not a vocabulary word —
 *      `(` immediately after a name; `.` immediately followed by another name (not `.` followed by
 *      nothing or punctuation, which is just a sentence's period — the exact bug a prior round hit
 *      live, on "...violates SSOT.md:99 structurally.**"); `=` not `==`; or `{`.
 *
 * What this still cannot do: recognise a declaration with no distinguishing capitalization and no
 * nearby structural boundary within three words (rare — most real code fails that only when the
 * words this check would see are themselves generic English, which is also when a human reading
 * the same citation would be unsure). That gap is a fact about what three words of context can
 * prove, not a list this check forgot to extend.
 */
const looksLikeCode = (text) => {
  const stripped = text.replace(/\(#\d+\)/g, "").trim();
  if (stripped.length === 0) return false;

  const leadingWords = stripped.match(/^(?:[A-Za-z_$][\w$]*\s+){0,4}[A-Za-z_$][\w$]*/);
  const scope = leadingWords ? leadingWords[0] : stripped.slice(0, 40);
  // camelCase / PascalCase (a lowercase letter directly followed by an uppercase one) or a
  // SCREAMING_SNAKE_CASE run (two-or-more-capitals, an underscore, another capital) — neither is
  // a shape English prose produces, and both are the ordinary naming convention in every language
  // this check reads.
  if (/[a-z][A-Z]/.test(scope) || /[A-Z]{2,}_[A-Z]/.test(scope)) return true;

  const firstWord = stripped.match(/^[A-Za-z_$][\w$]*/);
  if (!firstWord) return false;
  const afterFirst = stripped.slice(firstWord[0].length);
  // A call, a member access, or an assignment has to sit right after the *first* word, not
  // merely somewhere within the first few — "calls bindings.bind()" is an English sentence about
  // a call, and only widening this to "any of the first two or three words" (tried, and reverted)
  // reads it as code because "bindings" happens to be followed by ".bind(". Requiring the boundary
  // immediately after word one is what a real quoted line looks like; a describing sentence has a
  // verb there instead.
  if (/^\s*\(/.test(afterFirst)) return true; // name( — a call
  if (/^\.[A-Za-z_$]/.test(afterFirst)) return true; // name.member — a real member name after the dot
  if (/^\s*=[^=]/.test(afterFirst)) return true; // name = value — an assignment

  // `{` is the one boundary safe to look for further out: unlike `(`, `.`, or `=`, an English
  // sentence essentially never ends in an opening brace regardless of what comes before it, so a
  // wider "a name, maybe a second name, then `{`" window catches `interface DefinitelyGone {`
  // and similar declaration headers without also catching a sentence that happens to reach a
  // dotted call two words in.
  const braceScope = stripped.match(/^(?:[A-Za-z_$][\w$]*\s+){0,2}[A-Za-z_$][\w$]*/);
  if (braceScope && /^\s*\{/.test(stripped.slice(braceScope[0].length))) return true;

  // Round 10 added a fourth check here — a line ending in `;`, `{`, or `}` reads as code — to
  // catch `return null;` (real, vanished code that trips none of the three checks above: no
  // mixed-case identifier, no call/dot/assignment/brace immediately after "return"). Reverted in
  // round 11: it was too blunt in the direction of manufacturing code out of prose. The reasoning
  // that motivated it ("a sentence essentially never ends in `;`/`{`/`}`") is true of most English
  // prose and not all of it — a description enumerating a set (`role ∈ {ADMIN, USER}`) or ending a
  // clause with a semicolon by choice reads exactly like this check would need to see, and this
  // round's own reviewer flagged it as a suggestion that landed badly rather than one to narrow
  // further. Narrowing it again (excluding brace-enumerations, say) is the same shape this PR has
  // already rejected four times for a keyword list: a finite patch for a case found today, blind
  // to the next one. There is no authority this script already trusts — `git ls-files`, `readCode`
  // — that answers "is this quoted fragment prose or code" the way they answer "is this a file" or
  // "is this a comment": both questions are about the *tracked tree*, and a fenced citation's
  // quoted text is not in it. So this is dropped rather than refined, and the gap is named instead
  // of patched: a fenced statement with no distinguishing capitalization and no boundary
  // immediately after its first word — `return null;` chief among them — is not recognised as code
  // and stays ADVISORY even when genuinely gone. The same content *inline* is still caught (round
  // 8 trusts the explicit delimiter there unconditionally); this gap is specific to the fenced
  // branch, where the fence alone was never a strong enough signal to drop the heuristic entirely
  // (see the false-STALE round 8 found and fixed by keeping it) but is not strong enough either to
  // license guessing at punctuation as a substitute for it.
  return false;
};

/**
 * GitHub Markdown accepts fences of either marker, three or more characters long, with up to
 * three leading spaces. The closer must use the opening marker and be at least as long, with
 * only trailing whitespace. An opening fence may have any info string; backtick fences are the
 * one exception where a backtick in that string is invalid Markdown.
 */
const openingFence = (line) => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return null;
  return { marker: match[1][0], length: match[1].length };
};

const closesFence = (line, fence) =>
  new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[\\t ]*$`).test(line);

const extractFromBody = (body) => {
  const lines = body.split("\n");
  let fence = null;
  const seenPath = new Set();
  const seenSymbolRow = new Set();
  const seenNonDurable = new Set();
  const pathCitations = [];
  const symbolCitations = [];
  const nonDurable = [];

  for (const rawLine of lines) {
    if (fence) {
      if (closesFence(rawLine, fence)) {
        fence = null;
        continue;
      }
    } else {
      const opened = openingFence(rawLine);
      if (opened) {
        fence = opened;
        continue;
      }
    }

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

    // Round 4 opened content-checking to inline citations (not just fenced ones) — the #649
    // shape itself, written the ordinary way people actually write one, was never checked at
    // all before that. Round 5 narrows *how* an inline citation's content is found: only an
    // *explicit* delimiter (backticks or quotes right after the citation) counts as quoted at
    // all — a fenced line's content needs no such delimiter, because the fence itself is the
    // quotation mark. Guessing at unquoted prose is what let "This describes the banner text
    // and its return value has changed" read as a quote of code that was never there; requiring
    // an explicit delimiter removes that guess rather than refining it. `looksLikeCode` runs
    // only after a span is already known to be quoted, deciding whether *that* text reads as
    // code or as a description — never whether unquoted prose should be treated as a quote.
    //
    // Round 6: this has to run for *every* citation form, a GitHub permalink included. A
    // permalink was stored with `content: null` unconditionally — a URL's own shape has nothing
    // to do with whether the text right after it is a quote — so `binding-registry.ts#L163` next
    // to the exact same vanished line #649's plain-path form catches passed in silence. The parse
    // differs by form (a URL's match end sits after the whole link, a bare citation's after just
    // the path:line); what happens with the text following it does not.
    // Round 8, on `looksLikeCode`: asked here whether the heuristic is even needed once the text
    // is already known to be quoted, rather than tuned a fourth time. The answer differs by which
    // "quoted" this is:
    //
    //   - An inline citation's content only exists at all because `readDelimitedSpan` found an
    //     *explicit* backtick or quote mark right after the citation. That delimiter is the
    //     author's own deliberate act of quoting — choosing to wrap this specific span and not the
    //     rest of the sentence — and second-guessing it with "but does it look like code" is a
    //     check on a signal already stronger than the guess. `README.md:1` — `return null;` is
    //     exactly this: unmistakably quoted, unmistakably code, and `looksLikeCode` rejected it
    //     anyway (no mixed-case identifier, no call/dot/assignment/brace in its first three words)
    //     — a real false ADVISORY this check's own header calls STALE. Fixed by trusting the
    //     delimiter and skipping the heuristic entirely for this branch.
    //   - A fenced line's content has no delimiter of its own; the fence marks the *block* as
    //     code-like, not each row within it as a literal quote of the file it names. #649's own
    //     body is the proof this distinction is real, not theoretical: its fence mixes a literal
    //     quote (`const actorId = this.mintActor(...)`) with plain descriptions of what a range of
    //     lines does (`reconstitution is allowed when no active CEO exists (#619)`), and the
    //     second kind fails a literal match not because the fact is wrong but because a
    //     description was never going to appear verbatim. `looksLikeCode` stays on this branch
    //     because dropping it here reintroduces exactly that false STALE — checked directly against
    //     this fixture before deciding, not assumed.
    const contentAfter = (matchEnd, startLine) => {
      if (startLine === null) return null;
      const afterCitation = stripCitationSeparator(rawLine.slice(matchEnd));
      if (fence) {
        return afterCitation.length > 0 && looksLikeCode(afterCitation) ? afterCitation : null;
      }
      const delimited = readDelimitedSpan(afterCitation);
      return delimited && delimited.length > 0 ? delimited : null;
    };

    // A GitHub blob permalink to *this* repository is a precise, structured citation and is
    // parsed as one directly — see `GITHUB_BLOB_RE`'s comment for why the generic path regex
    // must not also be let loose on this text. A permalink to a different repository names
    // nothing in this tree and is dropped rather than misread as one of this repo's paths.
    if (repoSlug) {
      for (const m of rawLine.matchAll(GITHUB_BLOB_RE)) {
        const slug = `${m[1]}/${m[2]}`.toLowerCase();
        if (slug !== repoSlug) continue;
        const path = resolveBlobRefAndPath(m[3]);
        if (path === null) continue; // ref/path boundary not verifiable against a real branch
        const startLine = m[4] ? Number(m[4]) : null;
        const endLine = m[5] ? Number(m[5]) : null;
        const content = contentAfter(m.index + m[0].length, startLine);
        const key = `${path}:${startLine ?? ""}:${endLine ?? ""}:${content ?? ""}`;
        if (seenPath.has(key)) continue;
        seenPath.add(key);
        pathCitations.push({ raw: m[0], path, startLine, endLine, content });
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
      // A bare citation with neither a directory separator nor a line number is exactly as
      // ambiguous as an unquoted trailing sentence was in round 5 — "Node.js" and
      // "deploy/egress/allowlist-proxy.py" both end in a real-looking extension, but only the
      // second says anything about *this repository's tree* rather than a product name that
      // happens to contain a dot. See round 6's docstring note for the corpus evidence.
      //
      // Round 9: that holds for prose, not for a citation the author explicitly set apart with a
      // delimiter. `` `HANDOFF-CEO-RESUME.md` `` in backticks is exactly the #649 shape this check
      // exists for — a real, missing file — and it passed in total silence because this line
      // skipped every bare mention unconditionally, delimited or not. Round 5 already decided an
      // explicit delimiter is decisive for an inline citation's *content*; `isExplicitlyDelimited`
      // asks the same question of the citation itself, so a backtick- or quote-wrapped bare
      // mention is no longer skipped, while genuinely unquoted prose ("runs on Node.js 22") still
      // is — the ambiguity that skip exists for is real only in the absence of a delimiter.
      //
      // A delimiter alone proved too wide once measured against the real corpus: it also passed
      // `` `inbound_messages.turn_claim_json` `` and `` `ConversationTurnCoordinator.claim` `` —
      // a SQL column and a `Class.method` reference, both legitimately backtick-quoted, neither a
      // path. `knownExtensions` closes that gap the same authority-derived way round 6 closed the
      // last one: the dotted suffix has to be an extension this tracked tree actually uses.
      const bareDelimited =
        isExplicitlyDelimited(rawLine, m.index, m.index + m[0].length) && knownExtensions.has(extensionOf(path));
      if (startLine === null && !path.includes("/") && !bareDelimited) {
        continue;
      }
      const content = contentAfter(m.index + m[0].length, startLine);
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
    const symbols = [...m[2].matchAll(/`(#?[\w.$]+)(?:\(\))?`/g)].map((s) => s[1]);
    const key = `${path}:${symbols.join(",")}`;
    if (seenSymbolRow.has(key)) continue;
    seenSymbolRow.add(key);
    symbolCitations.push({ raw: m[0], path, symbols });
  }

  // See `SYMBOL_PROSE_RE`'s own comment for why this reversed-order form is recognised rather than
  // disclosed as a limitation. Same dedup key shape as the table form above (`path:symbol`), so a
  // symbol cited both ways collapses to one row instead of being reported twice.
  for (const m of body.matchAll(SYMBOL_PROSE_RE)) {
    const symbol = m[1];
    const path = m[2];
    const key = `${path}:${symbol}`;
    if (seenSymbolRow.has(key)) continue;
    seenSymbolRow.add(key);
    symbolCitations.push({ raw: m[0], path, symbols: [symbol] });
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
      // Round 13: the needle used to be built from `citation.content` verbatim — the citation's
      // *raw* quoted text — while round 11 moved the haystack to a stripped view, so an exact,
      // currently-correct citation that happens to quote a line containing a string literal read
      // STALE: the raw needle still had the string intact, and the stripped haystack had that same
      // span blanked, so a literal match against real, unchanged code failed on the one part of it
      // that was never supposed to compare asymmetrically in the first place. Fixed by stripping
      // the needle through the same per-extension view the haystack gets, so both sides agree
      // about what counts as "content" rather than one side searching in raw space and the other
      // in stripped space.
      //
      // Round 14 (#700 finding 2): that view used to be `stripToCodeView` — the *symbol-search*
      // view, which blanks string content on both sides too. That over-corrected: an elision-
      // tolerant regex built from a blanked string collapses to `\s+`, which matches *any* string
      // content of *any* length, so a citation quoting a string literal kept reading ADVISORY even
      // after the real string's content changed — the check reporting a coverage it did not have.
      // `stripCommentsForContentView` (see its own comment, above) strips comments only, on both
      // sides, and leaves string content untouched, so a changed string literal now reads STALE
      // and an unchanged one still reads ADVISORY. This does not reopen round 11's comment case: a
      // needle that is *itself* ordinary code (no `//`/`/* */`/`#` syntax in the quoted text)
      // strips to itself unchanged, so a citation whose old code now survives only inside the
      // file's comment still fails to match the (comment-stripped) haystack exactly as before. A
      // needle that quotes a comment *including its own marker* strips to nothing and yields no
      // pattern (`snippetPattern("")` is already `null`) — an unverifiable quote is treated the
      // same as no quoted content at all, falling through to ADVISORY rather than asserting a
      // fact this check cannot check.
      const needle = stripCommentsForContentView(citation.content, extensionOf(resolved.path));
      const pattern = snippetPattern(needle);
      // Searched near the cited line, not across the whole file. A file this size legitimately
      // repeats a shape — `binding-registry.ts` has a second, deliberate unconditional
      // `this.mintActor(...)` in an unrelated method 225 lines from the one #649 cited — and
      // matching anywhere would let that coincidence stand in for the cited line surviving.
      // The window is generous enough to tolerate the citation's line drifting from an ordinary
      // nearby edit; it is not generous enough to credit an unrelated function elsewhere in the
      // file with keeping this one's claim true.
      // `citedEnd - 1` is the 0-indexed array position of the cited line itself; `slice`'s end
      // bound is exclusive, so including everything up to and including `CONTENT_SEARCH_WINDOW`
      // lines past it needs `+ CONTENT_SEARCH_WINDOW` on top of that position, not folded into
      // the same `- 1` the start bound uses. Writing it as `citedEnd - 1 + CONTENT_SEARCH_WINDOW`
      // (as an earlier version of this line did) is one line short at the far edge: a real,
      // still-current citation exactly `CONTENT_SEARCH_WINDOW` lines past the cited line —
      // `README.md:121` cited as `README.md:61`, +60, the boundary the contract names — read as
      // vanished, because the slice stopped one line before it.
      //
      // Round 11: this searched `text` — the raw file, comments and strings included — not a
      // comment-stripped view. That is this check's own original defect, reappearing in the
      // direction it started in rather than the one it was fixed for: a citation whose code was
      // deleted but whose *old text survives inside a comment nearby* — the exact #649 shape,
      // just for a quoted snippet instead of a bare symbol — passed as ADVISORY, because the raw
      // text still contained it. Round 14 moved this from `readCode` (the symbol-search view) to
      // `readContentView` (comments stripped, strings preserved — see that function's comment):
      // both preserve every line exactly (each stripper blanks in place, never removing a line),
      // so the bounds established above are unaffected by the swap, and a comment mentioning old
      // code is still a sentence about it, not code that holds it.
      const windowLines = readContentView(resolved.path).split("\n");
      const from = Math.max(0, citation.startLine - 1 - CONTENT_SEARCH_WINDOW);
      const to = Math.min(windowLines.length, citedEnd + CONTENT_SEARCH_WINDOW);
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
      const pattern = symbolPattern(symbol);
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
          return (
            JS_FAMILY_EXTS.has(ext) ||
            PY_EXTS.has(ext) ||
            SH_EXTS.has(ext) ||
            YAML_EXTS.has(ext) ||
            SQL_EXTS.has(ext)
          );
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
