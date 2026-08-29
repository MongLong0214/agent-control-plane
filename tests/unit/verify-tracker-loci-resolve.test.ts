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
      expect(result.stdout).toContain("does not appear as code");
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
      expect(result.stdout).toContain("does not appear as code in src/core/reason-codes.ts");
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
      expect(result.stdout).toContain("does not appear as code");
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
      expect(result.stdout).toContain("does not appear as code");
      expect(result.stdout).not.toContain("does not resolve");
    } finally {
      cleanup();
    }
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
