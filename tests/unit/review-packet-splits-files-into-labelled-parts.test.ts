import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { __testing } from "../../src/review/blind-review.ts";
import {
  EXECUTION_EVIDENCE_CHAR_BUDGET,
  type ExecutionEvidence,
  type ReceiptEvidence,
  executionEvidenceSection,
} from "../../src/review/candidate-review-evidence.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/*
 * Run A (run_b86c2fe6, review art_b17686c9): a file larger than one review chunk was cut by UTF-16
 * unit, mid-line and mid-record, its later parts carried no hunk header and no label, and no chunk
 * reviewer was told the other ranges were reviewed elsewhere. Each reviewer called its fragment
 * incomplete. Its execution evidence listed 24 unlinked receipts before the npm test output and the
 * package.json it ran, which were cut to nothing. These are the witnesses for both.
 */

const IDENTITY = "github:acme/fixture";
type Part = ReturnType<typeof __testing.splitDiffs>["chunks"][number][number];

/** git's patch section adding `text` at `path`, as `git diff --full-index` writes it. */
const newFileSection = (path: string, text: string): string => {
  const lines = text.split("\n").slice(0, -1);
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex ${"0".repeat(40)}..${"ab".repeat(20)}\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}`;
};

const LABEL = new RegExp(
  "^Part (\\d+) of (\\d+) of this file's patch: characters \\[(\\d+), (\\d+)\\) of the (\\d+) after its file header, " +
    "from (inside )?patch line (\\d+)(?:, old line (\\d+), new line (\\d+))?\\. " +
    "(?:Its file header (?:and the header of the hunk it starts in are|is) repeated above it\\. )?" +
    "This part (completes|does not complete) the file\\.$",
);
/** The sentence a chunk prompt carries when it holds a range part, and only then. */
const RANGE_SENTENCE = "the file's other ranges are reviewed by other chunk reviewers";

interface Label { part: number; of: number; start: number; end: number; total: number; inside: boolean; line: number; old: number | null; new: number | null; completes: boolean }

const labelOf = (part: Part): Label => {
  const match = LABEL.exec((part as { rangeLabel?: string }).rangeLabel ?? "");
  expect(match, `label of ${part.files.join(",")}: ${(part as { rangeLabel?: string }).rangeLabel}`).not.toBeNull();
  const [, k, n, start, end, total, inside, line, old, added, completes] = match!;
  return {
    part: Number(k), of: Number(n), start: Number(start), end: Number(end), total: Number(total), inside: inside !== undefined,
    line: Number(line), old: old === undefined ? null : Number(old), new: added === undefined ? null : Number(added), completes: completes === "completes",
  };
};

const labelLength = (part: Part): number => (part as { rangeLabel?: string }).rangeLabel?.length ?? 0;

/**
 * Splits one oversized section at `budget` and checks every part against it: the full header on each
 * part (the file's header lines and the header of the hunk the range starts in), a label whose number,
 * range, starting line and completion flag are right, header and label inside `budget`, and the ranges
 * joined back into the section exactly. Returns each part's range text.
 */
const splitAndRejoin = (path: string, section: string, budget: number): { parts: Part[]; labels: Label[]; bodies: string[] } => {
  const { chunks, omitted, unmapped } = __testing.splitDiffs([{ identity: IDENTITY, diff: section, files: [path] }], budget);
  expect([omitted, unmapped]).toEqual([[], []]);
  const parts = chunks.flat();
  const fileHeader = section.slice(0, section.indexOf("\n@@ ") + 1);
  const payload = section.slice(fileHeader.length);
  const labels = parts.map(labelOf);
  const bodies: string[] = [];
  for (const [index, part] of parts.entries()) {
    const label = labels[index]!;
    expect([label.part, label.of, label.total, label.completes]).toEqual([index + 1, parts.length, payload.length, index === parts.length - 1]);
    expect(label.start).toBe(index === 0 ? 0 : labels[index - 1]!.end);
    expect(label.end).toBeGreaterThan(label.start);
    const body = part.diff.slice(part.diff.length - (label.end - label.start));
    const before = payload.slice(0, label.start);
    const hunk = payload.startsWith("@@ ", label.start) ? "" : ((before.match(/^@@ [^\n]*\n/gm) ?? []).at(-1) ?? "");
    expect(part.diff.slice(0, part.diff.length - body.length)).toBe(fileHeader + hunk);
    expect(label.line).toBe(section.slice(0, fileHeader.length + label.start).split("\n").length);
    expect(label.inside).toBe(section[fileHeader.length + label.start - 1] !== "\n");
    expect(part.files).toEqual([path]);
    expect(part.diff.length + labelLength(part), `part ${index + 1}`).toBeLessThanOrEqual(budget);
    bodies.push(body);
  }
  expect(labels.at(-1)!.end).toBe(payload.length);
  expect(fileHeader + bodies.join("")).toBe(section);
  return { parts, labels, bodies };
};

/** An episodes.py-like file: `count` lines of Python with Korean strings. */
const episodes = (count: number): string =>
  Array.from({ length: count }, (_, index) => `EPISODE_${index} = {"title": "에피소드 ${index}", "summary": "${"요약 ".repeat(1 + (index % 9))}"}\n`).join("");

/** An agent2_law.jsonl-like file: one Korean JSON record per line. */
const lawRecords = (count: number): string =>
  Array.from({ length: count }, (_, index) => `${JSON.stringify({ id: index, 조문: `제${index}조 ${"법률 조항 본문 ".repeat(1 + (index % 7))}` })}\n`).join("");

describe("witness 1: an oversized file is split into labelled parts that join back into it exactly", () => {
  it("splits a new file into at least three parts, each with the full header and its label, head, middle and tail present", () => {
    const section = newFileSection("data/episodes.py", episodes(3_000));
    const { labels, bodies } = splitAndRejoin("data/episodes.py", section, 50_000);

    expect(bodies.length).toBeGreaterThanOrEqual(3);
    // Head, middle and tail: the first part opens the hunk, a middle part neither starts nor completes, the last completes.
    expect(bodies[0]!.startsWith("@@ -0,0 +1,3000 @@\n+EPISODE_0 = ")).toBe(true);
    expect(labels.some((label) => label.part > 1 && !label.completes)).toBe(true);
    expect(bodies.at(-1)!.endsWith(`+${episodes(3_000).split("\n").at(-2)!}\n`)).toBe(true);
    // The starting line: the first part starts at the hunk header; every later one at the new file line its range opens.
    const fileHeader = section.slice(0, section.indexOf("\n@@ ") + 1);
    const payload = section.slice(fileHeader.length);
    expect([labels[0]!.old, labels[0]!.new]).toEqual([null, null]);
    for (const label of labels.slice(1)) {
      expect([label.old, label.new]).toEqual([0, payload.slice(0, label.start).split("\n").length - 1]);
    }
  });

  it("repeats the header of the hunk each range starts in, for a modified file with several hunks", () => {
    const hunk = (at: number, lines: number): string =>
      `@@ -${at},${lines} +${at},${lines + 1} @@ def block_${at}():\n` +
      Array.from({ length: lines }, (_, index) => (index % 3 === 0 ? `-old ${at + index}\n+new ${at + index}\n` : ` same ${at + index} 데이터\n`)).join("") +
      "+added\n";
    const section = `diff --git a/src/model.py b/src/model.py\nindex ${"1".repeat(40)}..${"2".repeat(40)} 100644\n--- a/src/model.py\n+++ b/src/model.py\n` +
      [10, 2_000, 9_000].map((at) => hunk(at, 900)).join("");
    const { parts, labels } = splitAndRejoin("src/model.py", section, 6_000);

    expect(parts.length).toBeGreaterThanOrEqual(3);
    // A later range inside a hunk names that hunk's old and new lines.
    expect(labels.slice(1).every((label) => label.old !== null || section.startsWith("@@ ", section.indexOf("\n@@ ") + 1 + label.start))).toBe(true);
    expect(parts.slice(1).some((part) => part.diff.includes("@@ -2000,900 +2000,901 @@ def block_2000():\n"))).toBe(true);
  });
});

describe("witness 2: a cut falls at a line end whenever one fits, and never inside a surrogate pair", () => {
  it("cuts Korean JSONL records only at line ends, each part as full as the next line allows", () => {
    const budget = 20_000;
    const section = newFileSection("data/agent2_law.jsonl", lawRecords(1_500));
    const { parts, labels, bodies } = splitAndRejoin("data/agent2_law.jsonl", section, budget);

    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const [index, body] of bodies.entries()) {
      expect(body.endsWith("\n"), `part ${index + 1}`).toBe(true);
      expect(labels[index]!.inside).toBe(false);
      if (index === bodies.length - 1) continue;
      // The next line would not have fitted: the label's reserve is a few hundred characters at most.
      const nextLine = bodies[index + 1]!.slice(0, bodies[index + 1]!.indexOf("\n") + 1);
      expect(parts[index]!.diff.length + labelLength(parts[index]!) + nextLine.length).toBeGreaterThan(budget - 512);
    }
  });

  it("cuts a line longer than a part with emoji and Korean without splitting a surrogate pair, and rejoins it exactly", () => {
    const line = "법😀".repeat(4_000);
    const section = newFileSection("data/one-line.txt", `short\n${line}\ntail\n`);
    // Three budgets one apart: a cut by UTF-16 unit lands inside a pair at one of them at least.
    for (const budget of [3_000, 3_001, 3_002]) {
      const { labels, bodies } = splitAndRejoin("data/one-line.txt", section, budget);
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      // The short line before the long one ends the first part; the long one is cut inside itself.
      expect(bodies[0]!).toBe("@@ -0,0 +1,3 @@\n+short\n");
      expect(labels.some((label) => label.inside)).toBe(true);
      for (const body of bodies) {
        expect(/[\uD800-\uDBFF]$/.test(body), `budget ${budget}`).toBe(false);
        expect(/^[\uDC00-\uDFFF]/.test(body), `budget ${budget}`).toBe(false);
      }
    }
  });
});

describe("witness 3: header and label count against the part's budget, and no chunk exceeds the threshold", () => {
  it("packs no chunk past its budget with the labels counted", () => {
    const budget = 30_000;
    const big = newFileSection("data/sources_all.csv", Array.from({ length: 2_500 }, (_, index) => `${index},출처 ${index},https://example.org/${index}\n`).join(""));
    const small = newFileSection("src/z.js", "module.exports = 1;\n");
    const { chunks } = __testing.splitDiffs([{ identity: IDENTITY, diff: big + small, files: ["data/sources_all.csv", "src/z.js"] }], budget);
    const ranges = chunks.flat().filter((part) => part.files[0] === "data/sources_all.csv");

    expect(ranges.length).toBeGreaterThanOrEqual(3);
    for (const part of ranges) {
      labelOf(part);
      expect(part.diff.length + labelLength(part)).toBeLessThanOrEqual(budget);
    }
    for (const chunk of chunks) {
      expect(chunk.reduce((size, part) => size + part.diff.length + labelLength(part), 0)).toBeLessThanOrEqual(budget);
    }
  });

  it("reviews a 300K-character file in labelled chunks, every chunk prompt inside the 120,000-char threshold", async () => {
    const setup = await prepareCandidate({ "data/episodes.py": episodes(4_200) });
    try {
      setup.harness.scripted.script(
        { match: /Review chunk/, text: reviewerPass([setup.key("src/app.js"), setup.key("data/episodes.py")]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      expect(result.value).toMatchObject({ chunked: true, verdict: "PASS", omittedItems: [] });
      const prompts = chunkPrompts(setup);
      const labelled = prompts.filter((prompt) => PROMPT_LABEL.test(prompt));
      expect(labelled.length).toBeGreaterThanOrEqual(3);
      for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(120_000);
      // The label sits above the patch, where a lockfile's line goes, and the patch opens with the file's header.
      for (const prompt of labelled) {
        expect(prompt).toMatch(/^- data\/episodes\.py\nPart \d+ of \d+ of this file's patch: [^\n]*\n```diff\ndiff --git a\/data\/episodes\.py b\/data\/episodes\.py\n/m);
      }
    } finally {
      setup.harness.cp.close();
    }
  }, 120_000);
});

describe("witness 4: coverage stays honest for range parts", () => {
  it("an unclaimed range still fails coverage", async () => {
    const setup = await prepareCandidate({ "data/episodes.py": episodes(4_200) });
    try {
      setup.harness.scripted.script(
        // The reviewer of part 2 claims only a file outside its chunk.
        { match: /^Part 2 of \d+ of this file's patch/m, text: reviewerPass([setup.key("src/app.js")]) },
        { match: /Review chunk/, text: reviewerPass([setup.key("src/app.js"), setup.key("data/episodes.py")]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
      const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
      expect(packet?.verdict).toBe("REVISE");
      expect(packet?.omittedItems).toContain(setup.key("data/episodes.py"));
    } finally {
      setup.harness.cp.close();
    }
  }, 120_000);

  it("a reviewer's omission inside a range part still blocks PASS", async () => {
    const setup = await prepareCandidate({ "data/episodes.py": episodes(4_200) });
    const omission = `${setup.key("data/episodes.py")}: this range's characters after EPISODE_1500 could not be read`;
    try {
      setup.harness.scripted.script(
        { match: /^Part 2 of \d+ of this file's patch/m, text: JSON.stringify({ verdict: "PASS",
          coveredFiles: [setup.key("src/app.js"), setup.key("data/episodes.py")], omittedItems: [omission], findings: [] }) },
        { match: /Review chunk/, text: reviewerPass([setup.key("src/app.js"), setup.key("data/episodes.py")]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
      const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
      expect(packet?.verdict).toBe("REVISE");
      expect(packet?.omittedItems).toContain(omission);
    } finally {
      setup.harness.cp.close();
    }
  }, 120_000);

  it("tells a chunk reviewer the other ranges are reviewed elsewhere only when its chunk holds a range part", async () => {
    const split = await prepareCandidate({ "data/episodes.py": episodes(4_200) });
    try {
      split.harness.scripted.script(
        { match: /Review chunk/, text: reviewerPass([split.key("src/app.js"), split.key("data/episodes.py")]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );
      const result = await split.invoke();
      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      const prompts = chunkPrompts(split);
      expect(prompts.filter((prompt) => PROMPT_LABEL.test(prompt)).length).toBeGreaterThanOrEqual(3);
      for (const prompt of prompts) expect(prompt.includes(RANGE_SENTENCE)).toBe(PROMPT_LABEL.test(prompt));
    } finally {
      split.harness.cp.close();
    }

    // Three whole files that need chunks but none of which is split: no chunk prompt carries the sentence or a label.
    const whole = await prepareCandidate(Object.fromEntries(["a", "b", "c"].map((name) => [`data/${name}.py`, episodes(500)])));
    try {
      const keys = ["src/app.js", "data/a.py", "data/b.py", "data/c.py"].map(whole.key);
      whole.harness.scripted.script(
        { match: /Review chunk/, text: reviewerPass(keys), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );
      const result = await whole.invoke();
      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      expect(result.value.chunked).toBe(true);
      const prompts = chunkPrompts(whole);
      expect(prompts.length).toBeGreaterThan(1);
      for (const prompt of prompts) {
        expect(prompt).not.toContain(RANGE_SENTENCE);
        expect(PROMPT_LABEL.test(prompt)).toBe(false);
      }
    } finally {
      whole.harness.cp.close();
    }
  }, 240_000);
});

describe("witness 5: the run's output and config text get room before receipts that are not linked", () => {
  const NPM_TEST_STDOUT = Array.from({ length: 160 }, (_, index) => `  ✓ tests/unit/case-${String(index).padStart(3, "0")}.test.ts > passes its case (${index} ms)\n`).join("")
    .padEnd(13_299, "=");
  const ROOT_PACKAGE_JSON = `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" }, engines: { node: ">=24" } }, null, 2)}\n`;
  const receipt = (index: number, linked: boolean): ReceiptEvidence => ({
    runId: "run_b86c2fe6", taskId: `task_${index}`, executionId: `exec_${String(index).padStart(4, "0")}`, status: "SUCCEEDED",
    repository: IDENTITY, baseHead: "b".repeat(40), commitHead: linked ? "a".repeat(40) : `${index}`.padStart(40, "c"),
    diffDigest: `sha256:${String(index).padStart(64, "d")}`, snapshotDiffDigest: `sha256:${"5".repeat(64)}`,
    recomputedDiffDigest: linked ? `sha256:${String(index).padStart(64, "d")}` : null, linked,
    mismatches: linked ? [] : ["the receipt's commit is not the candidate head", `the receipt's base head is not the snapshot's baseHead ${"b".repeat(40)}`],
  });
  const evidence = (stdout: string): ExecutionEvidence => ({
    commandSource: "the pinned manifest sha256:x, profile standard",
    commands: [{ commandId: "test", argv: ["npm", "test"], cwd: ".", required: true, repositoryRole: "primary", repository: IDENTITY,
      candidateHead: "a".repeat(40), configFileRule: "npm reads <cwd>/package.json",
      configFiles: [{ path: "package.json", state: "INCLUDED", detail: null, chars: ROOT_PACKAGE_JSON.length, redacted: false, truncated: false, content: ROOT_PACKAGE_JSON }] }],
    results: [{ commandId: "test", repositoryIdentity: IDENTITY, source: "local", exactHead: "a".repeat(40), status: "PASS", exitCode: 0,
      reasonCode: null, candidateSnapshotDigest: "s", contractDigest: "c", outputDigest: "o", captureTruncated: false,
      boundaryFragmentWithheld: false, output: "RETAINED", statement: null, stdoutChars: stdout.length, stderrChars: 0, redacted: false,
      truncated: false, stdout, stderr: "" }],
    repositories: [{ repository: IDENTITY, baseHead: "b".repeat(40), candidateHead: "a".repeat(40), linkedExecutionIds: ["exec_0000", "exec_0001"] }],
    receipts: [receipt(0, true), receipt(1, true), ...Array.from({ length: 24 }, (_, index) => receipt(index + 2, false))],
    receiptsNotListed: { outsideCandidateHistory: 0, notACandidateRepository: 0, noCommitReceipt: 0, overListLimit: 0, unchecked: 0 },
  });
  interface Rendered {
    verificationCommands: { commands: Array<{ configFiles: Array<{ content: string; truncated: boolean }> }> };
    officialResults: { results: Array<{ stdout: string; truncated: boolean }> };
    receipts: { total: number; listed: number; notListed: Record<string, number>; receipts: ReceiptEvidence[]; diffDigests: Array<{ executionId: string }> };
    cutForSize: boolean;
  }
  const render = (input: ExecutionEvidence): { doc: Rendered; text: string; used: number } => {
    const section = executionEvidenceSection(input, EXECUTION_EVIDENCE_CHAR_BUDGET);
    const text = section.lines.join("\n");
    return { doc: JSON.parse(text.split("```json\n")[1]!.split("\n```")[0]!) as Rendered, text, used: section.used };
  };
  /** Listed and total counts exact, linked receipts first, and every receipt not listed counted in notListed. */
  const expectHonestReceipts = (doc: Rendered, listedAtLeast: number): void => {
    expect(doc.receipts.total).toBe(26);
    expect(doc.receipts.listed).toBe(doc.receipts.receipts.length);
    expect(doc.receipts.diffDigests.map((entry) => entry.executionId)).toEqual(doc.receipts.receipts.map((entry) => entry.executionId));
    expect(doc.receipts.listed).toBeGreaterThanOrEqual(listedAtLeast);
    expect(doc.receipts.listed).toBeLessThan(26);
    expect(doc.receipts.receipts.slice(0, 2).map((entry) => [entry.executionId, entry.linked])).toEqual([["exec_0000", true], ["exec_0001", true]]);
    expect(doc.receipts.receipts.slice(2).every((entry) => !entry.linked)).toBe(true);
    expect(doc.receipts.notListed["overCharBudget"]).toBe(doc.receipts.total - doc.receipts.listed);
    expect(doc.cutForSize).toBe(true);
  };

  it("keeps a 13K npm test stdout and the root package.json whole beside 24 unlinked receipts, listing what fits after them", () => {
    const { doc, text, used } = render(evidence(NPM_TEST_STDOUT));

    expect(used).toBeLessThanOrEqual(EXECUTION_EVIDENCE_CHAR_BUDGET);
    expect(doc.officialResults.results[0]).toMatchObject({ stdout: NPM_TEST_STDOUT, truncated: false });
    expect(doc.verificationCommands.commands[0]!.configFiles[0]).toMatchObject({ content: ROOT_PACKAGE_JSON, truncated: false });
    // Some unlinked receipts still fit after the texts; the rest are counted, never dropped silently.
    expectHonestReceipts(doc, 3);
    expect(text).toContain("This execution evidence is incomplete: it was cut for size.");
  });

  it("cuts an output too long for the room only by its head-and-tail rule, marked, and counts every receipt it leaves out", () => {
    const long = `${"head line\n".repeat(2_000)}${"tail line\n".repeat(2_000)}`;
    const { doc, used } = render(evidence(long));

    expect(used).toBeLessThanOrEqual(EXECUTION_EVIDENCE_CHAR_BUDGET);
    const shown = doc.officialResults.results[0]!;
    expect(shown.truncated).toBe(true);
    const marker = /\n\[\.\.\. (\d+) characters omitted for size \.\.\.\]\n/.exec(shown.stdout);
    expect(marker).not.toBeNull();
    const [head, tail] = shown.stdout.split(marker![0]) as [string, string];
    expect(long.startsWith(head)).toBe(true);
    expect(long.endsWith(tail)).toBe(true);
    expect(head.length + tail.length + Number(marker![1])).toBe(long.length);
    // The text took its room before the unlinked receipts did: it is cut to most of the budget.
    expect(head.length + tail.length).toBeGreaterThan(EXECUTION_EVIDENCE_CHAR_BUDGET / 2);
    expect(doc.verificationCommands.commands[0]!.configFiles[0]).toMatchObject({ content: ROOT_PACKAGE_JSON, truncated: false });
    expectHonestReceipts(doc, 2);
  });
});

const CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const PROMPT_LABEL = /^Part \d+ of \d+ of this file's patch: /m;

const persistPassingVerification = (
  harness: ReturnType<typeof makeHarness>,
  run: { runId: string; contractDigest: string },
  snapshot: CandidateSnapshot,
): VerificationReport => {
  const snapshotDigest = candidateSnapshotDigest(snapshot);
  const repository = snapshot.repositories[0]!;
  const now = harness.clock.nowIso();
  const report: VerificationReport = {
    runId: run.runId, candidateSnapshotDigest: snapshotDigest, contractDigest: run.contractDigest, expectedInputs: 1, observedInputs: 1,
    results: [{ commandId: "verify", repositoryIdentity: repository.identity, source: "local", exactHead: repository.candidateHead,
      startedAt: now, endedAt: now, exitCode: 0, outputDigest: "sha256:test-verification-output", outputTruncated: false, status: "PASS", reasonCode: null }],
    status: "PASS", reasonCode: ReasonCode.OK, gaps: [],
  };
  harness.cp.artifacts.putEvidence(harness.cp.evidenceWritersForTests().VERIFICATION, run.runId, "VERIFICATION", report, snapshotDigest);
  harness.cp.db.run(
    `INSERT OR REPLACE INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`${snapshotDigest}:verify:${repository.identity}:local`, run.runId, snapshotDigest, "verify", repository.identity, "local",
      repository.candidateHead, now, now, 0, "sha256:test-verification-output", 0, "PASS", null],
  );
  return report;
};

/** A candidate that makes the passing change and adds `files`, frozen and verified, ready for review. */
const prepareCandidate = async (files: Record<string, string>) => {
  const harness = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const execution = harness.cp.tasks.startExecution({ runId: run.runId, taskId: task.taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(harness, task.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  applyPassingChange(harness.repoPath);
  writeFiles(harness.repoPath, files);
  const head = commitAll(harness.repoPath, "candidate files");
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const frozen = await harness.cp.pipeline.freeze(run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const snapshot = frozen.value;
  const verification = persistPassingVerification(harness, run, snapshot);
  const invoke = () => harness.cp.review.controlPlaneInvoker()({ runId: run.runId, projectId, executionMode: run.executionMode, snapshot,
    contract: CONTRACT, contractDigest: run.contractDigest, verification });
  return { harness, run, snapshot, invoke, key: (path: string): string => `${identity}:${path}` };
};

const chunkPrompts = (setup: { harness: ReturnType<typeof makeHarness> }): string[] =>
  setup.harness.scripted.invocations.map((invocation) => invocation.prompt).filter((prompt) => prompt.startsWith("# Review chunk"));
