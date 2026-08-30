import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface IssueFixture {
  number: number;
  title: string;
  body: string;
  url?: string;
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = join(repoRoot, "scripts", "verify-tracker-loci-resolve.mjs");
const issue649Fixture = join(repoRoot, "tests", "fixtures", "tracker-loci-issue-649.json");

/** Writes a throwaway `--issues-file` fixture and returns its path plus a cleanup function. */
const withIssues = (issues: IssueFixture[]) => {
  const dir = mkdtempSync(join(tmpdir(), "acp-tracker-loci-"));
  const path = join(dir, "issues.json");
  writeFileSync(path, JSON.stringify(issues, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const run = (issuesPath: string, extraArgs: string[] = []) =>
  spawnSync(process.execPath, [scriptPath, `--issues-file=${issuesPath}`, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });

describe("verify-tracker-loci-resolve", () => {
  it("#649: finds the real citation #657 made stale — binding-registry.ts:163 no longer unconditionally mints", () => {
    // The *real, untrimmed* body of issue #649 (tests/fixtures/tracker-loci-issue-649.json), not a
    // hand-shaped excerpt. A fixture trimmed down to only the fenced block that matters never
    // exercises the prose, the other fenced block (`continuity-kernel.ts`), the inline
    // `` `schema.sql:174-177` `` citation in the lead paragraph, or the Korean prose paragraph
    // around counterexample B — all of which are real and all of which the parser has to sit
    // next to without misfiring. A test that constructs a shape production never sees is the same
    // defect class Sol found in three other PRs today.
    //
    // #657 ("reconstitution reuses the actor a verified target names") rewrote `bind()` so line
    // 163 is not this assignment any more, and the assignment does not appear anywhere nearby in
    // the file either — the one place it still exists verbatim is an unrelated method ~225 lines
    // away (#449's deliberate unconditional mint on role replacement), which this check must not
    // credit as the cited line surviving.
    const result = run(issue649Fixture);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("STALE");
    expect(result.stdout).toContain("binding-registry.ts:163");
    expect(result.stdout).toContain("no longer appears");
    // The citations this check must NOT flag stale, present in the same real body: a prose
    // description ("reconstitution is allowed…"), a paraphrase around a real call ("calls
    // bindings.bind()"), and the lead paragraph's inline `schema.sql:174-177` — all still resolve
    // and should read as ADVISORY, never STALE.
    expect(result.stdout).toContain("hermes-bootstrap.ts:121-146");
    expect(result.stdout).toContain("hermes-bootstrap.ts:341");
    expect(result.stdout).toContain("schema.sql:174-177");
  });

  it("reports a missing file loudly", () => {
    const body = "The fix lives in `src/does/not/exist.ts:42`, which handles the retry.";
    const { path, cleanup } = withIssues([{ number: 9001, title: "missing file", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("src/does/not/exist.ts does not exist");
    } finally {
      cleanup();
    }
  });

  it("flags a /private/tmp citation as its own category, distinct from STALE", () => {
    // The #603/#676 shape: a ticket asserting custody over something under a scratchpad. The
    // path ends in `.py` deliberately: once `.py` became a recognized extension (fixing Sol's
    // counterexample 3a), the same text also matched as an ordinary bare-path citation and
    // double-reported as STALE ("does not exist") alongside the correct NON_DURABLE finding —
    // true, but redundant, and pointing a reader at "re-derive the claim from the code" for a
    // scratch path that re-deriving cannot fix. This pins the fix: exactly one category, once.
    const body =
      "Evidence for this was captured at `/private/tmp/acp-probe/scratch/derive3.py` and " +
      "the residual-zero census depends on it.";
    const { path, cleanup } = withIssues([{ number: 9002, title: "scratch custody", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("NON_DURABLE");
      expect(result.stdout).toContain("/private/tmp/acp-probe/scratch/derive3.py");
      expect(result.stdout).toContain("commit it, or accept it is gone");
      // Not the "STALE (" section header — the shared closing paragraph mentions the word STALE
      // even when only NON_DURABLE fired, to explain both categories together.
      expect(result.stdout).not.toContain("STALE (");
      expect(result.stdout).toContain("0 stale");
    } finally {
      cleanup();
    }
  });

  it("is silent on a subset with nothing to report", () => {
    // A bare path with no line number that resolves cleanly, and nothing else. Requirement 4:
    // a check that always prints becomes noise and stops being read.
    const body = "See `package.json` for the script list.";
    const { path, cleanup } = withIssues([{ number: 9003, title: "clean citation", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("an in-range file:line citation is ADVISORY, not a failure, unless --strict", () => {
    const body = "The status banner is at `README.md:1`.";
    const { path, cleanup } = withIssues([{ number: 9004, title: "advisory only", body }]);
    try {
      const plain = run(path);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain("ADVISORY");
      expect(plain.stdout).toContain("README.md:1");
      expect(plain.stdout).toContain("line numbers rot");

      const strict = run(path, ["--strict"]);
      expect(strict.status).toBe(1);
      expect(strict.stdout).toContain("ADVISORY");
    } finally {
      cleanup();
    }
  });

  it("a symbol citation in the repo's `path` — `symbol` table convention resolves silently", () => {
    const body = "`src/continuity/continuity-kernel.ts` — `failover`";
    const { path, cleanup } = withIssues([{ number: 9005, title: "symbol resolves", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("a symbol citation absent from src/ is STALE, worded as text-occurrence, not resolution", () => {
    const body = "`src/continuity/continuity-kernel.ts` — `definitelyNotARealSymbolXYZ`";
    const { path, cleanup } = withIssues([{ number: 9006, title: "symbol missing", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("definitelyNotARealSymbolXYZ");
      expect(result.stdout).toContain("does not appear");
      expect(result.stdout).toContain("src/continuity/continuity-kernel.ts");
    } finally {
      cleanup();
    }
  });

  // --- Sol's four counterexamples (xhigh, read-only review, BLOCK) ---------------------------
  // Each of these passed silently (exit 0) against the version reviewed. Fixed below; kept here
  // named for what they defeated, not folded into the tests above, so a future regression on any
  // one of them fails with the same name Sol used.

  it("counterexample 1 — a wrong directory with a real basename must not resolve in silence", () => {
    // `graveyard/continuity-kernel.ts` is not a real path anywhere in this tree; the only reason
    // it resolves at all is that `resolvePath`'s basename fallback matches it to
    // `src/continuity/continuity-kernel.ts` by filename alone. That fallback is load-bearing (see
    // the docstring on `resolvePath` — most real citations name less than the full path) so the
    // fix is not to remove it, it is to say so: a citation that only resolves by basename named
    // *something*, and what it named was not where the file actually is.
    const body =
      "Per the review, the failover comparison bug lives in `graveyard/continuity-kernel.ts` — " +
      "see the `sameProviderReplacement` assignment there.";
    const { path, cleanup } = withIssues([{ number: 8101, title: "moved-file counterexample", body }]);
    try {
      const plain = run(path);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain("ADVISORY");
      expect(plain.stdout).toContain("graveyard/continuity-kernel.ts");
      expect(plain.stdout).toContain("src/continuity/continuity-kernel.ts");
      expect(plain.stdout).toContain("only by matching its filename");

      const strict = run(path, ["--strict"]);
      expect(strict.status).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("counterexample 2 — an end-of-range line past the file's length is STALE, not just the start line", () => {
    const body = "The whole status banner logic is described across `README.md:1-999999`.";
    const { path, cleanup } = withIssues([{ number: 8102, title: "endLine counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("README.md:1-999999");
      expect(result.stdout).toContain("999999");
      expect(result.stdout).toContain("beyond it");
    } finally {
      cleanup();
    }
  });

  it("counterexample 3a — a .py citation is extracted, not silently dropped by the extension list", () => {
    const body =
      "The residual-zero census used to run through `scripts/definitely-missing-script.py`, " +
      "which was deleted when the census moved into TypeScript.";
    const { path, cleanup } = withIssues([{ number: 8103, title: "python extension counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("scripts/definitely-missing-script.py does not exist");
    } finally {
      cleanup();
    }
  });

  it("counterexample 3b — a GitHub-style #L anchor is parsed as a line citation, not ignored", () => {
    const body = "The status banner text is set in `README.md#L999999`.";
    const { path, cleanup } = withIssues([{ number: 8104, title: "anchor counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("README.md#L999999");
      expect(result.stdout).toContain("999999");
      expect(result.stdout).toContain("beyond it");
    } finally {
      cleanup();
    }
  });

  it("counterexample 4 — a symbol must resolve in the file the row cites, not merely somewhere under src/", () => {
    // `failover` is real, but it lives in `continuity-kernel.ts`, not `reason-codes.ts`. The old
    // check searched every file under `src/` for the symbol and was satisfied that it exists
    // *somewhere* — which defeats #597's actual rule: the row claims this specific file is the
    // enforcement site, not that the symbol is spelled correctly.
    const body = "`src/core/reason-codes.ts` — `failover`";
    const { path, cleanup } = withIssues([{ number: 8105, title: "wrong-file symbol counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("failover");
      expect(result.stdout).toContain("does not appear");
      expect(result.stdout).toContain("in src/core/reason-codes.ts");
      // Diagnostic aside: it says where the symbol actually lives, which is what made the
      // original defeat possible in the first place.
      expect(result.stdout).toContain("continuity-kernel.ts");
    } finally {
      cleanup();
    }
  });

  // --- Round 2: an independent review of the fixed commit (xhigh, read-only, BLOCK) ----------
  // One P0 (this check's own required CI step reddens `main` on an unedited tree, because #649
  // is open and already stale) and three P1 counterexamples reproduced by running the production
  // script, never a model of it.

  it("[P0] verify-tracker-loci-resolve.mjs runs only in the scheduled workflow, never a required PR step", () => {
    // The design fix, not a script fix: this check is a fact about the open issue tracker, not
    // about any one PR's diff, and it is *already* red on an unedited `main` — #649 cites a line
    // #657 moved, with no code change required to close that. A required `project-ci` step would
    // block every PR's merge on that fact for as long as the issue stays open. Pinned here as a
    // fact about the two workflow files so it cannot silently come back as a "just add the step"
    // PR: `project-ci` must never invoke this script, and the scheduled workflow must.
    const ciYaml = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const trackerYaml = readFileSync(join(repoRoot, ".github", "workflows", "tracker-loci.yml"), "utf8");
    // Not a bare substring check: `ci.yml` is allowed (and expected) to *document* why the step
    // is not here, which mentions the script by name in a comment. What must be absent is an
    // actual invocation of it as a step.
    expect(ciYaml).not.toContain("run: node scripts/verify-tracker-loci-resolve.mjs");
    expect(trackerYaml).toContain("run: node scripts/verify-tracker-loci-resolve.mjs");
    expect(trackerYaml).toContain("schedule:");
    expect(trackerYaml).not.toMatch(/^\s*pull_request:/m);
    expect(trackerYaml).not.toMatch(/^\s*push:/m);
  });

  it("[P1] a real GitHub blob permalink to this repo resolves by its actual path, not a URL fragment", () => {
    // The exact shape that broke: a whole, well-formed permalink. The earlier fix (generic
    // `#L`-anchor support) let the generic path regex loose on the URL's own text whenever a line
    // number was present, and it matched `com/<owner>/<repo>/blob/main/README.md` — a fragment of
    // the URL, not the path the link names — then reported that fragment ambiguous against every
    // tracked README. Fixed by parsing a GitHub blob URL to this repo structurally instead.
    const body =
      "See https://github.com/MongLong0214/agent-control-plane/blob/main/README.md#L1 for the status banner.";
    const { path, cleanup } = withIssues([{ number: 8301, title: "real permalink counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).toContain("README.md");
      expect(result.stdout).not.toContain("ambiguous");
      expect(result.stdout).not.toContain("STALE");
    } finally {
      cleanup();
    }
  });

  it("[P1] a permalink to a different repository is not read as a citation of this one", () => {
    const body = "Compare https://github.com/some-other-org/some-other-repo/blob/main/README.md#L1 for contrast.";
    const { path, cleanup } = withIssues([{ number: 8302, title: "foreign permalink", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[P1] a symbol mentioned only in a comment does not count as the cited file holding it", () => {
    // `reconstitution` is real prose in `binding-registry.ts` — it appears twice, both times in a
    // comment discussing the concept — but the file does not hold a symbol by that name. The
    // narrowed-to-one-file search from counterexample 4 still passed this pairing in silence
    // because it was still a plain text search, comments included.
    const body = "`src/session/binding-registry.ts` — `reconstitution`";
    const { path, cleanup } = withIssues([{ number: 8303, title: "comment-only symbol counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("reconstitution");
      expect(result.stdout).toContain("does not appear");
      expect(result.stdout).toContain("src/session/binding-registry.ts");
    } finally {
      cleanup();
    }
  });

  it("[P1] a .mts citation is extracted — a real tracked extension, not a guess", () => {
    const body = "The type declarations used to live in `scripts/definitely-missing.mts`, which was deleted.";
    const { path, cleanup } = withIssues([{ number: 8304, title: "mts extension counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("scripts/definitely-missing.mts does not exist");
    } finally {
      cleanup();
    }
  });

  it("[P1] the real tracked .mts file resolves cleanly", () => {
    const body = "Types live in `scripts/lib/collapse-trailer-paragraphs.d.mts`.";
    const { path, cleanup } = withIssues([{ number: 8305, title: "mts positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  // --- Round 3: a third independent review, run against the shipped script through
  // --issues-file, same as the prior two rounds. One case per finding, not combined, per the
  // explicit request — a combined `1-999999` case had hidden the fact that the boundary was
  // untested on both sides.

  it("[round 3] a citation of line 0 is STALE — a citation's first line is 1", () => {
    const body = "See `README.md:0`.";
    const { path, cleanup } = withIssues([{ number: 8501, title: "zero-line counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("README.md:0");
      expect(result.stdout).toContain("does not exist");
    } finally {
      cleanup();
    }
  });

  it("[round 3] a citation one line past the true end is STALE — the trailing newline is not a line", () => {
    // README.md has 196 lines. `text.split("\n").length` reads that as 197 (one trailing empty
    // element from the final newline), so `:197` — genuinely one past the end — passed as
    // "still resolves" until `countLines` stopped counting that element.
    const realLineCount = readFileSync(join(repoRoot, "README.md"), "utf8")
      .split("\n")
      .filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === "")).length;
    const body = `See \`README.md:${realLineCount + 1}\`.`;
    const { path, cleanup } = withIssues([{ number: 8502, title: "one-past-the-end counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain(`README.md has ${realLineCount} line(s)`);
    } finally {
      cleanup();
    }
  });

  it("[round 3] the true last line of a file is still ADVISORY, not STALE (the corrected boundary's other side)", () => {
    const realLineCount = readFileSync(join(repoRoot, "README.md"), "utf8")
      .split("\n")
      .filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === "")).length;
    const body = `See \`README.md:${realLineCount}\`.`;
    const { path, cleanup } = withIssues([{ number: 8503, title: "exact-last-line counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 3] an inverted range (end before start) is STALE", () => {
    const body = "See `README.md:20-10`.";
    const { path, cleanup } = withIssues([{ number: 8504, title: "inverted-range counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("inverted");
    } finally {
      cleanup();
    }
  });

  it("[round 3] a repeated locus with different quoted content is not collapsed by dedup", () => {
    // A bare `README.md:1` and a later fenced, stale `README.md:1  const definitelyGone = true`
    // cite the same path and line. The dedup key omitted the quoted content, so whichever the
    // extractor saw first (the bare, unfalsifiable one) silently absorbed the second — the one
    // citation that actually goes stale.
    const body = [
      "The banner is at `README.md:1`.",
      "",
      "```",
      "README.md:1  const definitelyGone = true",
      "```",
    ].join("\n");
    const { path, cleanup } = withIssues([{ number: 8505, title: "repeated-locus dedup counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("definitelyGone");
      expect(result.stdout).toContain("ADVISORY");
    } finally {
      cleanup();
    }
  });

  it("[round 3] a symbol appearing only as a quoted string literal does not count as code", () => {
    // `"utf8"` is a real, common string argument in `buzz-adapter.ts` — an encoding literal, not
    // a declared symbol. Comment-stripping (round 2) does not touch string content, so this
    // passed silently until `stripStrings` closed it too.
    const body = "`src/buzz/buzz-adapter.ts` — `utf8`";
    const { path, cleanup } = withIssues([{ number: 8506, title: "string-literal symbol counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("utf8");
      // Renamed per the round-3 decision: this is a text-occurrence check, not declaration
      // verification, and the report says so rather than claiming "resolve".
      expect(result.stdout).toContain("does not appear");
      expect(result.stdout).not.toContain("does not resolve");
    } finally {
      cleanup();
    }
  });

  // --- Round 4: a fourth independent review, run against the shipped script through
  // --issues-file, same as every prior round.

  it("[round 4] a symbol mentioned only in a Python # comment is not code", () => {
    // Round 2 stripped JS-style `//` and `/* */` comments, but `.py` is declared supported by
    // being in FILE_EXT at all — Python's own comment marker is `#`, and it was never stripped.
    const body = "`deploy/egress/allowlist-proxy.py` — `Digest`";
    const { path, cleanup } = withIssues([{ number: 8801, title: "python comment counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("Digest");
      expect(result.stdout).toContain("outside a `#` comment or quoted string");
      expect(result.stdout).toContain("deploy/egress/allowlist-proxy.py");
    } finally {
      cleanup();
    }
  });

  it("[round 4] a real Python identifier used as code (not a comment) still resolves silently", () => {
    const body = "`deploy/egress/allowlist-proxy.py` — `ALLOWLIST_DIGEST`";
    const { path, cleanup } = withIssues([{ number: 8802, title: "python positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 4] a symbol appearing only in a template literal's prose text is not code", () => {
    // `` `session lifecycle ${session.lifecycle} -> ${to} is not legal` `` — "legal" is the
    // author's own sentence, not a reference to anything. Round 3 stripped quoted strings but
    // deliberately left template literals alone entirely (a `${…}` interpolation is real code),
    // which meant the literal's *prose* half was still read as code too.
    const body = "`src/session/session-registry.ts` — `legal`";
    const { path, cleanup } = withIssues([{ number: 8803, title: "template literal counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("legal");
      expect(result.stdout).toContain("template-literal prose");
      expect(result.stdout).toContain("src/session/session-registry.ts");
    } finally {
      cleanup();
    }
  });

  it("[round 4] a symbol referenced inside a template literal's ${...} expression still resolves", () => {
    // `lifecycle` is used throughout this file as ordinary code, including as the
    // `${session.lifecycle}` expression inside the very template literal `legal` (above) is
    // prose in. Stripping a template literal's prose text must not take its `${…}` expressions
    // down with it — confirmed directly against `stripTemplateLiteralProse` too: given
    // `` `session lifecycle ${session.lifecycle} -> ${to} is not legal` ``, it returns
    // `` `                  ${session.lifecycle}    ${to}             ` `` — "legal" gone,
    // both expressions untouched, including the nested-brace case (an object literal inside a
    // `${…}`) and an unterminated backtick (blanks to end of string rather than running away).
    const body = "`src/session/session-registry.ts` — `lifecycle`";
    const { path, cleanup } = withIssues([{ number: 8804, title: "template literal expression positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 4] the report states per-language scope, not one blanket claim", () => {
    // Sol's ask directly: the script's own output has to say what it inspects, per language,
    // rather than one sentence ("outside a comment or quoted string") standing in for all of
    // them when the code underneath only understood one language's syntax.
    const pyBody = "`deploy/egress/allowlist-proxy.py` — `Digest`";
    const { path: pyPath, cleanup: pyCleanup } = withIssues([{ number: 8805, title: "py scope", body: pyBody }]);
    try {
      expect(run(pyPath).stdout).toContain("outside a `#` comment or quoted string");
    } finally {
      pyCleanup();
    }

    // A missing *file* short-circuits before the language line ever gets to print, so this uses
    // a real TS file with a symbol that is not there, rather than a missing path.
    const tsBody = "`src/session/session-registry.ts` — `definitelyNotARealSymbolABC`";
    const { path: tsPath, cleanup: tsCleanup } = withIssues([{ number: 8806, title: "ts scope", body: tsBody }]);
    try {
      expect(run(tsPath).stdout).toContain("outside a `//`/`/* */` comment, a quoted string, or template-literal prose");
    } finally {
      tsCleanup();
    }
  });

  it("[round 4] an inline citation (no code fence) is content-checked, not just a fenced one", () => {
    // The #649 shape itself, written the ordinary way people actually write a citation: inline,
    // mid-sentence, no ``` around it. Content was only ever captured inside a fenced block, so
    // this — the case this whole check exists for — was never checked at all.
    const body =
      "The rule at `binding-registry.ts:163` — `const actorId = this.mintActor(...)` no longer holds; " +
      "the reuse path runs first now.";
    const { path, cleanup } = withIssues([{ number: 8807, title: "inline stale citation counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("binding-registry.ts:163");
      expect(result.stdout).toContain('quoted content "const actorId = this.mintActor(...)"');
      expect(result.stdout).toContain("no longer appears");
      // The citer's own sentence after the closing backtick must not have been swept into the
      // quoted content — that would check the citation against a string no file ever contained.
      expect(result.stdout).not.toContain("no longer holds");
    } finally {
      cleanup();
    }
  });

  it("[round 4] an inline citation whose quoted content still holds is ADVISORY, not STALE", () => {
    const body = "The banner text is set in `README.md:1` — `# Agent Control Plane` — right at the top.";
    const { path, cleanup } = withIssues([{ number: 8808, title: "inline current citation control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 4] an ordinary sentence-ending period after a bare citation is not read as code", () => {
    // Found live, on the real corpus, while verifying the inline-citation fix: opening content
    // capture to every citation (not just fenced ones) meant `looksLikeCode`'s dotted-access
    // check — "a dot right after the word" — started firing on ordinary prose. #627's real body
    // cites `SSOT.md:99` twice; the second time bare, ending "...violates SSOT.md:99
    // structurally.**" — a markdown bold-close sitting right after the sentence's period. That
    // matched `/^\./` on "structurally.**" and came within one check of being read as member
    // access, which would have manufactured quoted content no file ever contained and produced a
    // duplicate, wrongly-STALE report for a citation that was in fact merely repeated. Fixed by
    // requiring a real identifier character after the dot, not just the dot itself.
    const body = "The path violates `README.md:1` structurally.**";
    const { path, cleanup } = withIssues([{ number: 8809, title: "sentence-ending period counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
      // Never manufactured "structurally.**" (or anything else) as quoted content to check.
      expect(result.stdout).not.toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  // --- Round 5: a fifth independent review, run against the shipped script through
  // --issues-file. Three counterexamples, one underlying shape (a hand-maintained list deciding
  // what counts — a symbol-form regex, a code-vs-prose keyword list), addressed by deleting the
  // guessing rather than tuning the list a fourth time. See the round 5 docstring for the full
  // argument on why.

  it("[round 5] a symbol cited with parentheses is not invisible to the row regex", () => {
    // `SYMBOL_ROW_RE` did not allow `()` on a symbol at all — a citation written the way people
    // actually write a function reference, `definitelyMissing()`, matched nothing and produced an
    // empty result, not merely an unresolved one.
    const body = "`src/session/session-registry.ts` — `definitelyMissing()`";
    const { path, cleanup } = withIssues([{ number: 9201, title: "symbol paren counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("definitelyMissing");
      expect(result.stdout).toContain("src/session/session-registry.ts");
    } finally {
      cleanup();
    }
  });

  it("[round 5] a genuinely vanished quoted declaration is STALE, not silently ADVISORY", () => {
    // `interface DefinitelyGone {` is a real declaration header the old keyword list did not
    // recognise (it knew `const`/`let`/`return`/…, not `interface`), so this fenced, genuinely
    // quoted, genuinely gone line read as merely "still resolves at line 1" — contradicting this
    // script's own header, which claims a vanished quoted line is STALE.
    const body = ["See below:", "", "```", "session-registry.ts:1  interface DefinitelyGone {", "```", ""].join("\n");
    const { path, cleanup } = withIssues([{ number: 9202, title: "interface keyword counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("interface DefinitelyGone");
      expect(result.stdout).toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  it("[round 5] unquoted prose is never read as a citation's content, even using words that are also code keywords", () => {
    // `this` and `return` are ordinary English words that also happen to be JS keywords; the old
    // list treated the mere presence of either as proof of quoted code, so a plain sentence
    // describing a citation — no delimiter anywhere — was checked as if it were a literal quote
    // and reported as a stale citation of a string no file ever contained.
    const body =
      "The rule at `README.md:1` this describes the banner text and its return value has changed since.";
    const { path, cleanup } = withIssues([{ number: 9203, title: "unquoted prose keyword counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
      expect(result.stdout).not.toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  it("[round 5] an English sentence describing a call is not mistaken for the call itself", () => {
    // Found while verifying the fix above, against the real #649 fixture: widening the
    // call/member/assignment boundary to "within the first few words" (rather than immediately
    // after the first word) made "calls bindings.bind()" — a real line in #649's own body,
    // correctly ADVISORY since #619 — match as code, because "bindings" is followed by
    // ".bind(". The whole phrase, paraphrase word included, then became the literal content to
    // check, and "calls" is not in the source — a false STALE manufactured by the fix meant to
    // remove false ADVISORYs. Reverted to requiring the boundary right after word one; `{` stays
    // the one exception (see the docstring beside `looksLikeCode`).
    const body = ["```", "hermes-bootstrap.ts:341       calls bindings.bind()", "```"].join("\n");
    const { path, cleanup } = withIssues([{ number: 9204, title: "paraphrase call counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
      expect(result.stdout).not.toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  it("[round 5] a fenced literal call is still checked and found current", () => {
    const body = ["```", "src/bootstrap/hermes-bootstrap.ts:341   cp.bindings.bind({...})", "```"].join("\n");
    const { path, cleanup } = withIssues([{ number: 9205, title: "fenced literal call positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  // --- Round 6: a sixth independent review, run against the shipped script. Two
  // counterexamples — a content-check bypass, and the extension list problem once more.

  it("[round 6] a GitHub permalink with vanished quoted content is STALE, not silently ADVISORY", () => {
    // The exact #649 stale content (`binding-registry.ts:163`), cited as a permalink with a `#L`
    // anchor and an explicit backtick quote right after it instead of the plain-path form. The
    // permalink extraction path stored `content: null` unconditionally, so this passed as
    // ADVISORY ("still resolves") while the identical content cited as a plain path was correctly
    // STALE — the same fact, checked or not depending only on which citation form named it.
    const body =
      "See https://github.com/MongLong0214/agent-control-plane/blob/main/src/session/binding-registry.ts#L163 " +
      "— `const actorId = this.mintActor(...)` for the mint call.";
    const { path, cleanup } = withIssues([{ number: 9401, title: "permalink vanished content counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("binding-registry.ts");
      expect(result.stdout).toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  it("[round 6] a permalink whose quoted content still holds remains ADVISORY", () => {
    const body = "See https://github.com/MongLong0214/agent-control-plane/blob/main/README.md#L1 — `# Agent Control Plane`.";
    const { path, cleanup } = withIssues([{ number: 9402, title: "permalink current content control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 6] a real tracked file with an uncommon extension is recognized, not invisible", () => {
    // `.txt` was never in the old enumerated extension list, so a real, tracked citation of it
    // was silently never even considered — indistinguishable from silence on a valid citation.
    const body = "See `tests/fixtures/buzz-cli/cli-version.txt:1` for the format.";
    const { path, cleanup } = withIssues([{ number: 9403, title: "txt extension counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).toContain("cli-version.txt");
    } finally {
      cleanup();
    }
  });

  it("[round 6] an ordinary product name with no directory or line number is not read as a citation", () => {
    // "Node.js" ends in a real extension (`.js`) and, with the old enumerated list, matched and
    // was reported STALE — a sentence about a runtime, not a citation of this repository's tree.
    const body = "This runs on Node.js 22 and nothing else.";
    const { path, cleanup } = withIssues([{ number: 9404, title: "product name counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 6] an undelimited bare product name and an undelimited real bare filename are not told apart, and neither is checked", () => {
    // The disambiguator (directory separator or line number) is uniform: it does not special-case
    // markdown or any other extension. An undelimited bare `HANDOFF-CEO-RESUME.md` mention — no
    // backticks, no directory, no line number — is exactly as syntactically ambiguous as an
    // undelimited `Node.js` is, and this is the traded-off cost reported in the round 6 docstring
    // rather than hidden: it is no longer flagged even though (unlike Node.js) it would in fact
    // resolve to nothing. This remains true after round 9 — see the round 9 tests below for the
    // *delimited* case, which is a different, now-fixed defect, not this one.
    const body = "See HANDOFF-CEO-RESUME.md for the full context.";
    const { path, cleanup } = withIssues([{ number: 9405, title: "bare markdown mention control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 6] a directory-qualified bare mention with an uncommon extension is still checked", () => {
    // The positive control for the disambiguator itself: a directory separator is enough to
    // qualify a bare mention (no line number) as a real citation, regardless of extension.
    const body = "The fixture lives at `tests/fixtures/buzz-cli/cli-version.txt`.";
    const { path, cleanup } = withIssues([{ number: 9406, title: "directory-qualified bare mention control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  // --- Round 7: a seventh independent review. One of these findings had already been published
  // and acted on — see the round 7 docstring for the retraction this caused on #576.

  it("[round 7] a real, extensionless, dotfile-directory path resolves and is checked", () => {
    // `.githooks/pre-commit` is real, tracked, and has no extension at all — the old extension
    // requirement made it invisible regardless of what it resolved to.
    const body = "See `.githooks/pre-commit:999999` for the guard.";
    const { path, cleanup } = withIssues([{ number: 9601, title: "dotfile no-extension counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain(".githooks/pre-commit");
      expect(result.stdout).toContain("beyond it");
    } finally {
      cleanup();
    }
  });

  it("[round 7] a genuinely missing extensionless dotfile path is STALE, not silent", () => {
    const body = "See `.githooks/definitely-gone:42` for the guard.";
    const { path, cleanup } = withIssues([{ number: 9602, title: "dotfile no-extension missing counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain(".githooks/definitely-gone does not exist");
    } finally {
      cleanup();
    }
  });

  it("[round 7] a leading dot on a path is kept, not dropped and read as a different path", () => {
    // This is the exact shape that produced a real, published false finding: `\b` cannot fire at
    // a dot preceded by whitespace (both sides non-word), so the match silently started one
    // character late and `.github/workflows/ci.yml` read as `github/workflows/ci.yml` — which then
    // resolved only by basename, and was reported as "missing its leading dot" when the real
    // citation had the dot correctly. There must be no basename-fallback advisory here at all: the
    // literal, dotted path has to match exactly.
    const body = "See `.github/workflows/ci.yml:1` for CI.";
    const { path, cleanup } = withIssues([{ number: 9603, title: "leading dot preserved counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).toContain(".github/workflows/ci.yml");
      expect(result.stdout).not.toContain("only by matching its filename");
    } finally {
      cleanup();
    }
  });

  it("[round 7] a bare directory or a state/status pair with no line number is not read as a citation", () => {
    // Found while verifying the fix above: dropping the extension requirement for *any* path with
    // a directory separator (tried first) added 46 false "citations" to the real corpus — GitHub
    // route fragments, state-pair notation, bare directories, digit/digit counts. None of these
    // carry a line number, which is exactly what distinguishes a real extensionless file citation
    // (`.githooks/pre-commit:999999`) from a fragment of running prose.
    const body =
      "The transition goes READY/DRAINING, and the route is /repos/:o/:r/check-runs/:id under src/github.";
    const { path, cleanup } = withIssues([{ number: 9604, title: "extensionless prose counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 7] a private JavaScript field cited as a symbol resolves when it is really declared", () => {
    // `#observe` is a real private method on `turn-coordinator.ts`. The old symbol regex did not
    // allow `#` at all, so this row matched nothing and produced no output whether the symbol was
    // present or fictitious — unable to tell the two apart.
    const body = "`src/conversation/turn-coordinator.ts` — `#observe`";
    const { path, cleanup } = withIssues([{ number: 9605, title: "private symbol positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 7] a fictitious private JavaScript field is STALE, distinguishing it from a real one", () => {
    const body = "`src/conversation/turn-coordinator.ts` — `#definitelyMissing`";
    const { path, cleanup } = withIssues([{ number: 9606, title: "private symbol counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("#definitelyMissing");
      expect(result.stdout).toContain("does not appear");
    } finally {
      cleanup();
    }
  });

  // --- Round 8: an eighth independent review, run against the shipped script. Two parsing
  // fixes and a decision on the heuristic question this PR has answered twice before.

  it("[round 8] a backtick-wrapped permalink with no #L anchor does not capture the closing backtick", () => {
    // With no `#L…` to stop the path capture at `#`, nothing stopped it at the closing backtick
    // either — `README.md\`` does not exist, and a real link to a real file exited 1.
    const body = "See `https://github.com/MongLong0214/agent-control-plane/blob/main/README.md` for details.";
    const { path, cleanup } = withIssues([{ number: 9801, title: "backtick permalink counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 8] a backtick-wrapped permalink to a genuinely missing file is still STALE", () => {
    const body = "See `https://github.com/MongLong0214/agent-control-plane/blob/main/scripts/does-not-exist.mjs` for details.";
    const { path, cleanup } = withIssues([{ number: 9802, title: "backtick permalink missing file counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("scripts/does-not-exist.mjs");
      expect(result.stdout).not.toContain("`");
    } finally {
      cleanup();
    }
  });

  it("[round 8] a permalink built from this repo's own multi-segment branch name resolves correctly", () => {
    // The exact branch this fix was written on. `/blob/<ref>/<path>` assumed `<ref>` is one
    // segment, so this read as file `597-tracker-loci-resolve-or-the-check-says-so/README.md` —
    // never existed, reported STALE — instead of the real file, `README.md`, on the real branch.
    const body =
      "See https://github.com/MongLong0214/agent-control-plane/blob/" +
      "feat/597-tracker-loci-resolve-or-the-check-says-so/README.md for the change.";
    const { path, cleanup } = withIssues([{ number: 9803, title: "multi-segment branch ref counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 8] a multi-segment-ref permalink to a genuinely missing file is still STALE, not silently skipped", () => {
    const body =
      "See https://github.com/MongLong0214/agent-control-plane/blob/" +
      "feat/597-tracker-loci-resolve-or-the-check-says-so/scripts/does-not-exist.mjs for the change.";
    const { path, cleanup } = withIssues([{ number: 9804, title: "multi-segment branch ref missing file counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("scripts/does-not-exist.mjs");
    } finally {
      cleanup();
    }
  });

  it("[round 8] a permalink to a directory (not a file) is still checked against tracked files", () => {
    // `main` is a known ref (`knownRefs` resolves it directly, independent of whether anything
    // past it exists), so the split is never in question here — `docs/adr` is what remains, a
    // real directory but not a tracked file, and reporting "does not exist" is accurate for a
    // file-existence check even though it does not have a distinct category for "this is a
    // directory". An earlier version of this fix tried resolving the split only against tracked
    // files with no independent ref authority, under which this citation went silent instead —
    // which looked like an improvement until the same change made a *deleted file* behind a
    // multi-segment ref go silent too, the one case this check exists to catch. Restoring
    // `knownRefs` fixed both at once, and returned this one to reporting what it always reported.
    const body = "See https://github.com/MongLong0214/agent-control-plane/blob/main/docs/adr for the rule.";
    const { path, cleanup } = withIssues([{ number: 9805, title: "directory permalink control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("docs/adr does not exist");
    } finally {
      cleanup();
    }
  });

  it("[round 8] explicitly quoted code that has vanished is STALE even when it trips no code heuristic", () => {
    // `return null;` is unmistakably code and unmistakably quoted (an explicit backtick span
    // right after the citation) — and it trips none of `looksLikeCode`'s checks (no mixed-case
    // identifier, no call/dot/assignment/brace in its first words). The fix is not a fifth check
    // added to that heuristic: an inline citation's content only exists because of an explicit
    // delimiter, which is the author's own act of quoting, and the heuristic is dropped entirely
    // for that branch rather than asked to recognise one more shape.
    const body = "The banner check at `README.md:1` — `return null;` no longer holds.";
    const { path, cleanup } = withIssues([{ number: 9806, title: "return null heuristic gap counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("return null;");
      expect(result.stdout).toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  it("[round 8] explicitly quoted prose that is still current is ADVISORY, not asserted stale on a technicality", () => {
    const body = "The banner text is set in `README.md:1` — `# Agent Control Plane` — right at the top.";
    const { path, cleanup } = withIssues([{ number: 9807, title: "explicit quote positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 8] fenced content still needs to read as code — the heuristic stays on that branch", () => {
    // The other half of the round 8 decision: a fenced line has no delimiter of its own, and
    // #649's real body proves the fence alone is not a reliable "this row is a literal quote"
    // signal — it mixes exactly this kind of plain description with a literal quote in one fence.
    // Dropping the heuristic here would reintroduce a false STALE for this real citation.
    const body = ["```", "hermes-bootstrap.ts:121-146   reconstitution is allowed when no active CEO exists (#619)", "```"].join("\n");
    const { path, cleanup } = withIssues([{ number: 9808, title: "fenced description positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  // --- Round 9: an independent review found two silently-skipped citation forms — one pinned
  // by a test that read the gap as intended behaviour — plus an off-by-one at the ±60 window's
  // upper edge. Fixed below; the corpus diff that shaped `knownExtensions` is in the commit.

  it("[round 9] a backtick-delimited bare filename mention is a citation, not skipped as prose", () => {
    // The delimiter is the author's own act of quoting — the same decisive signal round 5 already
    // trusts for an inline citation's *content* (see `readDelimitedSpan`) — so a bare mention set
    // apart with backticks is a real citation even with no directory and no line number, unlike
    // the undelimited case in the round 6 test above. `HANDOFF-CEO-RESUME.md` has never existed in
    // this tree; this was the exact shape an independent review found passing in total silence.
    const body = "See `HANDOFF-CEO-RESUME.md` for the full context.";
    const { path, cleanup } = withIssues([{ number: 9901, title: "delimited bare mention counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("HANDOFF-CEO-RESUME.md does not exist");
    } finally {
      cleanup();
    }
  });

  it("[round 9] a backtick-delimited product name is checked exactly like every other delimited bare mention", () => {
    // The disambiguator was never really "does this look like a real path" — it is "did the
    // author mark this as a citation" — so a backtick-quoted `Node.js` is treated the same as a
    // backtick-quoted `HANDOFF-CEO-RESUME.md`, even though "js" happens to be a real extension in
    // this tree and "Node.js" is not a real citation of anything in it. This is the accepted cost
    // of trusting the delimiter, stated rather than hidden: an author who backtick-quotes a
    // product name pays for the same rule that lets a backtick-quoted stale filename be caught.
    const body = "This runs on `Node.js` and nothing else.";
    const { path, cleanup } = withIssues([{ number: 9902, title: "delimited product name counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("Node.js does not exist");
    } finally {
      cleanup();
    }
  });

  it("[round 9] a backtick-quoted SQL column or Class.method reference is not read as a file citation", () => {
    // Measured against the real open-issue corpus before trusting the delimiter fix above: a
    // delimiter alone also passed `` `inbound_messages.turn_claim_json` `` (a real SQL column,
    // #695) and `` `ConversationTurnCoordinator.claim` `` (a class.method reference, #693) as if
    // either were a path citation — neither is one, and neither's dotted suffix is an extension
    // this repository's tracked tree actually uses. `knownExtensions` closes that gap the same
    // git-ls-files-is-the-authority way round 6 closed the last one.
    const body = "The ingress ledger (`inbound_messages.turn_claim_json`) is unaffected by this change.";
    const { path, cleanup } = withIssues([{ number: 9903, title: "sql column false positive counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 9] a backtick-quoted mention of a real but untracked runtime file is not read as a file citation", () => {
    // `state.db` is a real, live artifact this repository deliberately does not track — a check
    // over the tracked tree has no basis to call it "missing" just because git does not carry it.
    // "db" is not an extension anything committed here uses, so `knownExtensions` excludes it the
    // same way it excludes a SQL column's fake "extension" above — same gate, different reason.
    const body = "If contention on the shared Hermes `state.db` appears, the run stops.";
    const { path, cleanup } = withIssues([{ number: 9904, title: "untracked runtime file counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 9] a symbol cited the ordinary prose way (`symbol` in `path`) is recognized, not only the table form", () => {
    // The repo's own `` `path` — `symbol` `` table convention was the only form `SYMBOL_ROW_RE`
    // recognized; a citation written the ordinary way people write English about code — reversed
    // order, connected by "in" instead of "—" — matched nothing and produced no output, unable to
    // tell a present symbol from a fictitious one. Both spans here are already backtick-delimited,
    // the same explicit-quoting signal the table form itself relies on.
    const body = "missing symbol is `definitelyMissing()` in `src/session/session-registry.ts`";
    const { path, cleanup } = withIssues([{ number: 9905, title: "prose symbol form counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("definitelyMissing");
      expect(result.stdout).toContain("does not appear");
      expect(result.stdout).toContain("src/session/session-registry.ts");
    } finally {
      cleanup();
    }
  });

  it("[round 9] a real symbol cited the prose way resolves silently, same as the table form", () => {
    const body = "The private method `#observe` in `src/conversation/turn-coordinator.ts` handles this.";
    const { path, cleanup } = withIssues([{ number: 9906, title: "prose symbol form positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 9] a quoted line exactly at the ±60 window boundary is ADVISORY, not STALE", () => {
    // The window's own comment and header both claim ±60; the code checked one line narrower at
    // the far edge. Real text from `README.md:121` cited at line 61 — exactly +60, inside the
    // stated window — returned STALE before this fix. Reproduced here against README.md's real,
    // current content (not a fixture) so a future edit cannot silently make this test meaningless
    // — the same discipline the round 3 boundary tests already use.
    const lines = readFileSync(join(repoRoot, "README.md"), "utf8").split("\n");
    const WINDOW = 60;
    let citedLine = null;
    let content = null;
    for (let start = 1; start + WINDOW <= lines.length; start++) {
      const candidate = (lines[start + WINDOW - 1] ?? "").trim();
      if (candidate.length > 15 && !/[`"'/\\]/.test(candidate)) {
        citedLine = start;
        content = candidate;
        break;
      }
    }
    expect(citedLine).not.toBeNull();
    const body = `See \`README.md:${citedLine}\` — \`${content}\` for the detail.`;
    const { path, cleanup } = withIssues([{ number: 9907, title: "window boundary exact counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 9] a quoted line one line past the ±60 window boundary is STALE (the corrected boundary's other side)", () => {
    const lines = readFileSync(join(repoRoot, "README.md"), "utf8").split("\n");
    const WINDOW = 60;
    let citedLine = null;
    let content = null;
    for (let start = 1; start + WINDOW + 1 <= lines.length; start++) {
      const candidate = (lines[start + WINDOW] ?? "").trim(); // one line past the boundary
      if (candidate.length > 15 && !/[`"'/\\]/.test(candidate)) {
        citedLine = start;
        content = candidate;
        break;
      }
    }
    expect(citedLine).not.toBeNull();
    const body = `See \`README.md:${citedLine}\` — \`${content}\` for the detail.`;
    const { path, cleanup } = withIssues([{ number: 9908, title: "window boundary one-past counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  // --- Round 10: an independent review found two places where this script's own stated contract
  // and its actual behaviour had drifted apart — an extensionless root-level file invisible for
  // want of a directory separator it never needed, and a fenced citation's vanished code passing
  // because the header claimed the fence alone decides while the code still ran a heuristic.

  it("[round 10] an extensionless, root-level, real tracked file with a line past its end is STALE", () => {
    // `.gitignore` is real, tracked, has no extension, and lives at the repo root — no directory
    // separator at all. The extensionless branch of `PATH_RE` required one on top of the line
    // number, so this matched nothing regardless of what it resolved to; only the directory-
    // qualified case (`.githooks/pre-commit:999999`, round 7) was ever covered.
    const body = "See `.gitignore:999999` for the ignore rules.";
    const { path, cleanup } = withIssues([{ number: 91001, title: "root dotfile line-past-end counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain(".gitignore has");
      expect(result.stdout).toContain("beyond it");
    } finally {
      cleanup();
    }
  });

  it("[round 10] a genuinely missing extensionless, root-level path with a line number is STALE, not silent", () => {
    const body = "See `.definitely-missing:42` for the detail.";
    const { path, cleanup } = withIssues([{ number: 91002, title: "root dotfile missing counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain(".definitely-missing does not exist");
    } finally {
      cleanup();
    }
  });

  it("[round 10] an extensionless, root-level, real tracked file that resolves is ADVISORY, the positive control", () => {
    const body = "See `.gitignore:1` for the ignore rules.";
    const { path, cleanup } = withIssues([{ number: 91003, title: "root dotfile positive control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 10, reverted round 11] a fenced bare statement with no distinguishing identifier or boundary is a disclosed gap, not silently correct", () => {
    // `return null;` is unmistakably code and unmistakably gone from `README.md:1` — but it has no
    // mixed-case identifier and no call/dot/assignment/brace boundary immediately after "return".
    // Round 10 added a fourth check (a trailing `;`/`{`/`}`) to catch exactly this; round 11
    // reverted it — true of most English prose, not all of it (a set enumeration or a deliberate
    // semicolon-ended clause trips it too), and there is no authority this script already trusts
    // that answers "is this fenced quote prose or code" the way `git ls-files`/`readCode` answer
    // "is this a file"/"is this a comment". So this stays ADVISORY, disclosed rather than hidden:
    // the same content *inline* (see the round 8 test above) is still caught, because an inline
    // citation trusts its explicit delimiter unconditionally and never needed this heuristic at
    // all — the gap is specific to the fenced branch, where neither "trust the fence" nor "guess
    // at trailing punctuation" turned out to be a substitute for a real signal.
    const body = ["```ts", "README.md:1  return null;", "```"].join("\n");
    const { path, cleanup } = withIssues([{ number: 91004, title: "fenced statement disclosed-gap control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 10/11] a fenced description ending in a statement terminator by coincidence is still not manufactured — regression guard", () => {
    // The exact #649 shapes round 8 protects. Round 10 briefly widened `looksLikeCode` to catch a
    // trailing statement terminator and verified neither of these two real fenced lines ends in
    // `;`/`{`/`}` once the `(#619)`-style aside is stripped; round 11 reverted that widening
    // entirely for being too blunt in the other direction. This guard stays regardless of which
    // state `looksLikeCode` is in, because it pins the thing that must never happen on this
    // branch: a plain description manufactured into a false STALE.
    const descriptionBody = ["```", "hermes-bootstrap.ts:121-146   reconstitution is allowed when no active CEO exists (#619)", "```"].join(
      "\n",
    );
    const { path: descPath, cleanup: descCleanup } = withIssues([
      { number: 91005, title: "fenced description regression guard", body: descriptionBody },
    ]);
    try {
      const result = run(descPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      descCleanup();
    }

    const paraphraseBody = ["```", "hermes-bootstrap.ts:341       calls bindings.bind()", "```"].join("\n");
    const { path: paraPath, cleanup: paraCleanup } = withIssues([
      { number: 91006, title: "fenced paraphrase regression guard", body: paraphraseBody },
    ]);
    try {
      const result = run(paraPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      paraCleanup();
    }
  });

  // --- Round 11: an eleventh independent review found two round-10 regressions (both from
  // suggestions the reviewer made and then flagged as too coarse) plus this check's original
  // defect reappearing for a quoted snippet instead of a bare symbol.

  it("[round 11] a port number or an HTTP status code is not read as a file citation", () => {
    // Round 10 loosened the extensionless branch to accept *any* bare word with a line number —
    // `localhost:3000` and `HTTP:404` are the same `word:number` shape as a real citation and both
    // matched, reporting "localhost does not exist" / "HTTP does not exist". A line number alone
    // was never a strong enough signal; restored the second one round 6 established: every
    // extensionless file this repository tracks either sits under a directory or carries a
    // leading dot at the root (confirmed against `git ls-files` directly), and neither word here
    // has either.
    const body = "The dev server runs on localhost:3000 and returns HTTP:404 on a bad route.";
    const { path, cleanup } = withIssues([{ number: 92001, title: "port and status code counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("[round 11] an extensionless root-level dotfile and a directory-qualified extensionless path still resolve — positive controls", () => {
    // The disambiguator is "directory separator OR leading dot", not "line number alone" — these
    // two are the positive side of the round 10 regression fix above, confirming the fix did not
    // overcorrect back to round 7's own gap.
    const dotfileBody = "See `.gitignore:1` for the ignore rules.";
    const { path: dotPath, cleanup: dotCleanup } = withIssues([
      { number: 92002, title: "root dotfile still resolves control", body: dotfileBody },
    ]);
    try {
      const result = run(dotPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      dotCleanup();
    }

    const dirBody = "See `.githooks/pre-commit:1` for the guard.";
    const { path: dirPath, cleanup: dirCleanup } = withIssues([
      { number: 92003, title: "directory-qualified extensionless still resolves control", body: dirBody },
    ]);
    try {
      const result = run(dirPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      dirCleanup();
    }
  });

  it("[round 11] quoted content surviving only inside a comment is STALE, not credited as the code surviving", () => {
    // The check's own original defect, reappearing in the direction it was fixed for: the content
    // search read `readText`'s raw output, comments included, while the symbol search has used
    // `readCode` (comment/string-stripped) since round 2. `server.close()` is real text in
    // `src/daemon/agentcpd.ts` — but only inside a comment about it, ~30 lines from the citation;
    // the actual call happens 901 lines away, far outside the ±60 window. Before this fix, the raw
    // text still contained the phrase (inside the comment) and this read ADVISORY.
    const body = "The fix is at `src/daemon/agentcpd.ts:1420` — `server.close()` for the shutdown guard.";
    const { path, cleanup } = withIssues([{ number: 92004, title: "comment-only survival counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("server.close()");
      expect(result.stdout).toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  it("[round 11] quoted content that is real, current code (not a comment) still resolves — positive control", () => {
    const body = ["```", "src/bootstrap/hermes-bootstrap.ts:341   cp.bindings.bind({...})", "```"].join("\n");
    const { path, cleanup } = withIssues([{ number: 92005, title: "real code content still resolves control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 11] a multi-line block comment ahead of the cited line does not desynchronize the content-search window from the real file", () => {
    // Found while verifying the readCode fix above against the real corpus (#630), not
    // constructed first: `stripSlashComments`/`stripSqlComments` used to replace a matched
    // `/* ... */` block comment — which can legitimately span several lines — with a single
    // fixed-width string, collapsing every newline the comment contained. That was invisible for
    // as long as `readCode`'s only caller asked "does this symbol appear anywhere", never "at
    // which line" — the content-search window above is the first caller that slices `readCode`'s
    // output by line number, and a multi-line docstring ahead of the cited line silently shifted
    // every line after it out of sync with the real file, making the window look at the wrong
    // span entirely. `src/runtime/hermes-ceo.ts` has several multi-line `/** ... */` blocks before
    // line 341; the real call this citation names sits nine lines below it, comfortably inside the
    // ±60 window — but only if the window's line numbers still mean what the real file's do.
    const body = ["```", "src/runtime/hermes-ceo.ts:341   void askReplySource(options.replyCommand, …)", "```"].join("\n");
    const { path, cleanup } = withIssues([{ number: 92006, title: "multi-line comment desync counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  // --- Round 13: an independent review found the mirror of round 11's own fix — the content-
  // search needle was built from the citation's *raw* quoted text while round 11 moved the
  // haystack to `readCode`, which also strips string-literal content. An exact, currently-correct
  // citation that happens to quote a line containing a string literal read STALE.

  it("[round 13] an exact, current citation whose quoted code contains a string literal is ADVISORY, not STALE", () => {
    // The real, current line at `session-registry.ts:148`, quoted verbatim including its string
    // literal argument. Before this fix: the raw needle still had `"unknown session"` intact, the
    // `readCode`-stripped haystack had that same span blanked to spaces, and a literal match
    // against real, unchanged code failed on the one part of it that was never supposed to compare
    // literally in the first place.
    const body =
      "The check is at `src/session/session-registry.ts:148` — " +
      '`if (!row) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });` for the guard.';
    const { path, cleanup } = withIssues([{ number: 93001, title: "string literal in needle counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 13] the same real line's shape without a string literal was already ADVISORY — the paired control", () => {
    // The line immediately after the one above, real and current, with no string literal in it.
    // This already worked before the fix; pinned here so the two tests read as the pair Sol's
    // report described rather than one fix looking isolated.
    const body = "The check is at `src/session/session-registry.ts:150` — `const expected = hashSessionSecret(sessionSecret);` for the guard.";
    const { path, cleanup } = withIssues([{ number: 93002, title: "no string literal in needle control", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 13] a needle that is entirely a comment strips to nothing and is treated as unverifiable, not a crash", () => {
    // Stripping the needle the same way the haystack is stripped means a quote that names its own
    // comment marker (`// old code: doSomething()`, backtick-quoted including the `//`) reduces to
    // nothing. `snippetPattern("")` is already `null` elsewhere in this script; falling through to
    // ADVISORY (the same treatment a citation with no quoted content at all gets) is the defined
    // answer, not an unverifiable claim asserted as fact.
    const body = "See `src/session/session-registry.ts:1` — `// old code: doSomething()` for context.";
    const { path, cleanup } = withIssues([{ number: 93003, title: "comment-only needle counterexample", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ADVISORY");
      expect(result.stdout).not.toContain("STALE (");
    } finally {
      cleanup();
    }
  });

  it("[round 13] the round 11 comment-survival fix is unaffected: stripping the needle does not reopen it", () => {
    // The needle here (`server.close()`) has no comment/string syntax in the quoted text itself,
    // so stripping it changes nothing — it still fails to match the (comment-stripped) haystack
    // exactly as round 11 intended. This is the regression guard that would have failed if the
    // fix here had been "stop stripping the haystack" instead of "also strip the needle".
    const body = "The fix is at `src/daemon/agentcpd.ts:1420` — `server.close()` for the shutdown guard.";
    const { path, cleanup } = withIssues([{ number: 93004, title: "comment-survival regression guard", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("server.close()");
      expect(result.stdout).toContain("no longer appears");
    } finally {
      cleanup();
    }
  });

  // The property this round's fix actually needs, generalized past the one shape Sol reported:
  // citing a real, current line verbatim — across every language this check strips comments and
  // strings for — must never read STALE just because the line happens to contain a string
  // literal. Round 13 deliberately excluded `.py` here: verifying this property against
  // `deploy/egress/allowlist-proxy.py` surfaced a separate, real defect (a triple-quoted docstring
  // desynchronizes `stripStrings`' quote pairing for the rest of the file, #700) that was not that
  // round's needle/haystack asymmetry. Round 14 closes #700 (`stripPythonSource`) and Python is
  // included below — the exclusion no longer applies.
  const REAL_STRING_LITERAL_CITATIONS: Array<{ label: string; path: string; line: number; content: string }> = [
    {
      label: "TypeScript, a double-quoted string argument",
      path: "src/session/session-registry.ts",
      line: 148,
      content: 'if (!row) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });',
    },
    {
      label: "SQL, a single-quoted string argument",
      path: "src/db/schema.sql",
      line: 32,
      content: "SELECT RAISE(ABORT, 'MANIFEST_IMMUTABLE');",
    },
    {
      label: "shell, a double-quoted assignment",
      path: "deploy/install-launchd.sh",
      line: 5,
      content: 'readonly LABEL="com.agentcontrolplane.agentcpd"',
    },
    {
      // #700's own concrete counterexample: this is the occurrence the corrupted triple-quote
      // pairing was eating (line 77), not the coincidental one 7 lines later (line 84) that let
      // the pre-existing round-4 symbol-search test pass for the wrong reason the whole time.
      label: "Python, a double-quoted string literal, after a triple-quoted module docstring (#700)",
      path: "deploy/egress/allowlist-proxy.py",
      line: 77,
      content: 'ALLOWLIST_DIGEST = "sha256:" + hashlib.sha256(_f.read()).hexdigest()',
    },
  ];

  describe("[round 13] property: a real, current line containing a string literal is never STALE", () => {
    for (const { label, path: filePath, line, content } of REAL_STRING_LITERAL_CITATIONS) {
      it(label, () => {
        const body = `See \`${filePath}:${line}\` — \`${content}\` for the detail.`;
        const { path, cleanup } = withIssues([{ number: 93010 + line, title: `string-literal property: ${label}`, body }]);
        try {
          const result = run(path);
          expect(result.status).toBe(0);
          expect(result.stdout).toContain("ADVISORY");
          expect(result.stdout).not.toContain("STALE (");
        } finally {
          cleanup();
        }
      });
    }
  });

  describe("[round 14] #700 finding 2: string content is compared literally, not skipped", () => {
    it("a citation whose quoted string literal no longer matches the real one reads STALE", () => {
      // The real, current line at session-registry.ts:148 says "unknown session"; this citation
      // quotes the same line with the string literal's content swapped for something else
      // entirely. Round 13's own fix (stripToCodeView on both sides) blanked string content out of
      // the comparison, which made this pass as ADVISORY — the check reporting coverage over
      // string content it was not actually comparing. Round 14's `stripCommentsForContentView`
      // leaves string content in place, so a changed string is a changed citation.
      const body =
        'See `src/session/session-registry.ts:148` — ' +
        '`if (!row) return deny(ReasonCode.NOT_FOUND, "totally different text", { sessionId });` for the detail.';
      const { path, cleanup } = withIssues([{ number: 70002, title: "finding 2: swapped string content", body }]);
      try {
        const result = run(path);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("STALE");
        expect(result.stdout).toContain("totally different text");
        expect(result.stdout).toContain("no longer appears");
      } finally {
        cleanup();
      }
    });

    it("a citation whose quoted content differs only inside a comment (not a string) still reads ADVISORY", () => {
      // The companion case: comments are still excluded from the content-search comparison (round
      // 11's own fix, unaffected by round 14) — only string-content sensitivity changed. A needle
      // that is ordinary code with no comment syntax in it strips to itself unchanged on both
      // sides, so this is really the same regression guard as the round-13 property tests above,
      // named explicitly here as the "comments still don't count" half of the round 14 decision.
      const body = "The fix is at `src/daemon/agentcpd.ts:1420` — `server.close()` for the shutdown guard.";
      const { path, cleanup } = withIssues([{ number: 70003, title: "finding 2: comment still excluded", body }]);
      try {
        const result = run(path);
        // This is the exact round-11 regression guard fixture: the real call moved away from this
        // line and now only survives in a nearby comment, so it correctly stays STALE — comments
        // are not part of "content" either before or after round 14.
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("STALE");
      } finally {
        cleanup();
      }
    });
  });

  describe("[round 15] #689: the JS/TS comment stripper was never string-aware — the third instance of this script's own most-repeated defect", () => {
    it("module.exports in tests/integration/pipeline.test.ts:184 occurs only inside a string containing an embedded //, and reads STALE — the real repo citation, not a constructed fixture", () => {
      // The real shape found in this repository, not hand-built: `tests/integration/
      // pipeline.test.ts:184` writes `"module.exports = () => 2; // addressed review\n"` as a
      // string. `module.exports` appears nowhere else in the file as real code — both of its
      // occurrences (line 184 and line 372) are inside string literals that each contain their own
      // embedded `//`. Before this fix, `stripSlashComments` ran first, blind to the string
      // boundary; the embedded `//` (no `:` right before it, the one shape its lookbehind
      // protected) truncated the line and destroyed the string's own closing quote before
      // `stripStrings` ever ran, leaving `module.exports = () => 2; ` looking like ordinary code
      // that `stripJsSource`'s predecessor pipeline never recognized as string content at all —
      // `stale: []`, exit 0, the opposite of this script's own contract that a symbol found only
      // inside a string is STALE.
      const body = "`module.exports` in `tests/integration/pipeline.test.ts`";
      const { path, cleanup } = withIssues([{ number: 68901, title: "round 15: // inside a string bypasses the symbol search", body }]);
      try {
        const result = run(path);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("STALE");
        expect(result.stdout).toContain("module.exports");
        expect(result.stdout).toContain("does not appear");
        expect(result.stdout).toContain("tests/integration/pipeline.test.ts");
      } finally {
        cleanup();
      }
    });

    it("a real, current TypeScript identifier used as code (not only inside a string) still resolves silently — positive control", () => {
      const body = "`withIssues` in `tests/unit/verify-tracker-loci-resolve.test.ts`";
      const { path, cleanup } = withIssues([{ number: 68902, title: "round 15: real code identifier still resolves", body }]);
      try {
        const result = run(path);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
      } finally {
        cleanup();
      }
    });
  });

  it("--json emits parseable structured output", () => {
    const body = "`src/does/not/exist.ts:1` is the culprit.";
    const { path, cleanup } = withIssues([{ number: 9007, title: "json mode", body }]);
    try {
      const result = run(path, ["--json"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.stale.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
