import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { __testing } from "../../src/review/blind-review.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const IDENTITY = "github:acme/fixture";
const LOCKFILE = "compositor/package-lock.json";

/** Lockfile text of exactly `bytes` bytes over `lines` lines, the shape of an npm v3 lockfile body. */
const lockfileText = (bytes: number, lines: number): string => {
  const body = Array.from({ length: lines - 1 }, (_, index) => `    "node_modules/p${String(index).padStart(5, "0")}": "1.0.0",\n`).join("");
  const last = `  "end": "${"x".repeat(bytes - body.length - 12)}"\n`;
  const text = body + last;
  if (text.length !== bytes) throw new Error(`fixture is ${text.length} bytes, not ${bytes}`);
  return text;
};

/** The `git diff --full-index` section that adds `text` at `path`. */
const newFileSection = (path: string, text: string, blob = "ab".repeat(20)): string => {
  const lines = text.split("\n").slice(0, -1);
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex ${"0".repeat(40)}..${blob}\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}`;
};

/** A modified file's section from blob `base` to blob `candidate`, changing the lines `removed` to `added` at line 1. */
const modifiedSection = (path: string, removed: readonly string[], added: readonly string[], header = `diff --git a/${path} b/${path}\n`): string =>
  `${header}index ${"11".repeat(20)}..${"22".repeat(20)} 100644\n--- a/${path}\n+++ b/${path}\n` +
  `@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((line) => `-${line}\n`).join("")}${added.map((line) => `+${line}\n`).join("")}`;

const CANDIDATE_BLOB = "22".repeat(20);
/** The room a review gives a lockfile chunk beside about 84K of metadata and the 4,096-char envelope. */
const WORST_CASE_ROOM = __testing.LOCKFILE_CHUNK_THRESHOLD_CHARS - 84_000 - 4_096;

describe("a lockfile is reviewed whole in its own chunk, never cut into ranges", () => {
  it("keeps a 155,291-byte added lockfile like the live one whole in a chunk of its own, its patch not doubled", () => {
    const small = newFileSection("src/app.js", "module.exports = () => 2;\n", "cd".repeat(20));
    const lock = newFileSection(LOCKFILE, lockfileText(155_291, 4_287));
    const { chunks, omitted } = __testing.splitDiffs(
      [{ identity: IDENTITY, diff: lock + small, files: [LOCKFILE, "src/app.js"] }],
      100_000,
      200_000,
    );

    expect(omitted).toEqual([]);
    const holding = chunks.filter((chunk) => chunk.some((part) => part.files.includes(LOCKFILE)));
    expect(holding).toHaveLength(1);
    expect(holding[0]).toHaveLength(1);
    expect(holding[0]![0]!.diff).toBe(lock);
    expect(holding[0]![0]!.lockfile).toBe(
      `Lockfile ${LOCKFILE}, added, reviewed whole in this chunk: the patch below adds its full text, candidate blob ${"ab".repeat(20)} (git's digest of its full bytes).`,
    );
    expect(holding[0]![0]!.coverageTargets).toHaveLength(1);
    expect(chunks.flat().some((part) => part.files.includes("src/app.js") && part.diff === small)).toBe(true);
  });

  it("keeps the live-size lockfile whole under the cap beside the most metadata a chunk carries", () => {
    const lock = newFileSection(LOCKFILE, lockfileText(155_291, 4_287));
    const { chunks, omitted } = __testing.splitDiffs([{ identity: IDENTITY, diff: lock, files: [LOCKFILE] }], 120_000 - 84_000 - 4_096, WORST_CASE_ROOM);

    expect(omitted).toEqual([]);
    expect(chunks.map((chunk) => chunk.map((part) => part.diff))).toEqual([[lock]]);
  });

  it("keeps a lockfile exactly at the cap whole and omits one a byte over, naming it and the reason", () => {
    const fits = newFileSection(LOCKFILE, lockfileText(150_000, 4_000));
    const over = newFileSection(LOCKFILE, lockfileText(150_001, 4_000));
    expect(over.length).toBe(fits.length + 1);
    const measured = __testing.splitDiffs([{ identity: IDENTITY, diff: fits, files: [LOCKFILE] }], 100_000, 1_000_000).chunks.flat()[0]!;
    const cap = measured.lockfile!.length + fits.length;

    const atCap = __testing.splitDiffs([{ identity: IDENTITY, diff: fits, files: [LOCKFILE] }], 100_000, cap);
    expect(atCap.omitted).toEqual([]);
    expect(atCap.chunks.flat().map((part) => part.diff)).toEqual([fits]);

    const oneOver = __testing.splitDiffs([{ identity: IDENTITY, diff: over, files: [LOCKFILE] }], 100_000, cap);
    expect(oneOver.omitted).toEqual([
      `${IDENTITY}:${LOCKFILE}: lockfile not reviewed: shown whole it needs ${cap + 1} chars, more than the ${cap} chars ` +
        "one lockfile review chunk holds; a lockfile is not cut into ranges",
    ]);
    expect(oneOver.chunks.flat().some((part) => part.files.includes(LOCKFILE))).toBe(false);
  });

  it("omits an 832,937-byte modified lockfile whose full candidate text does not fit, and never calls its patch whole", () => {
    const text = lockfileText(832_937, 20_000);
    const section = modifiedSection(LOCKFILE, ['    "node_modules/p00002": "1.0.0",'], ['    "node_modules/p00002": "2.0.0",']);
    const { chunks, omitted } = __testing.splitDiffs(
      [{ identity: IDENTITY, diff: section, files: [LOCKFILE] }],
      100_000,
      WORST_CASE_ROOM,
      new Map([[CANDIDATE_BLOB, text]]),
    );

    expect(omitted).toHaveLength(1);
    const reason = new RegExp(
      `^${IDENTITY}:${LOCKFILE}: lockfile not reviewed: shown whole it needs (\\d+) chars, more than the ${WORST_CASE_ROOM} chars one lockfile review chunk holds; a lockfile is not cut into ranges$`,
    ).exec(omitted[0]!);
    expect(Number(reason?.[1])).toBeGreaterThan(text.length);
    expect(chunks.flat().some((part) => part.files.includes(LOCKFILE) || part.lockfile !== undefined)).toBe(false);
  });

  it("shows a modified lockfile that fits as its full candidate text and its change, the patch or else its changed line ranges", () => {
    const text = lockfileText(50_000, 1_000);
    const section = modifiedSection(LOCKFILE, ['    "node_modules/p00002": "1.0.0",'], ['    "node_modules/p00002": "2.0.0",']);
    const whole = __testing.splitDiffs([{ identity: IDENTITY, diff: section, files: [LOCKFILE] }], 100_000, WORST_CASE_ROOM, new Map([[CANDIDATE_BLOB, text]]));

    expect(whole.omitted).toEqual([]);
    expect(whole.chunks).toHaveLength(1);
    const part = whole.chunks[0]![0]!;
    expect(part.diff).toBe(section);
    expect(part.lockfile).toContain(`\`\`\`text\n${text}\n\`\`\``);
    expect(part.lockfile).toContain(`"end": "${"x".repeat(12)}`);
    expect(part.lockfile).toContain(`candidate blob ${CANDIDATE_BLOB}`);
    expect(part.lockfile).toContain(`base blob ${"11".repeat(20)} as its complete patch`);

    const large = lockfileText(200_000, 4_000);
    const lines = large.split("\n").slice(0, 2_500);
    const broad = modifiedSection(LOCKFILE, lines, lines.map((line) => line.replace("1.0.0", "2.0.0")));
    const ranged = __testing.splitDiffs([{ identity: IDENTITY, diff: broad, files: [LOCKFILE] }], 100_000, 250_000, new Map([[CANDIDATE_BLOB, large]]));

    expect(ranged.omitted).toEqual([]);
    const shown = ranged.chunks[0]![0]!;
    expect(shown.diff).toBe(`diff --git a/${LOCKFILE} b/${LOCKFILE}\nindex ${"11".repeat(20)}..${CANDIDATE_BLOB} 100644\n--- a/${LOCKFILE}\n+++ b/${LOCKFILE}\n@@ -1,2500 +1,2500 @@\n`);
    expect(shown.lockfile).toContain(`\`\`\`text\n${large}\n\`\`\``);
    expect(shown.lockfile).toContain("as the changed line ranges of its patch");
  });

  it("recognises a lockfile renamed to a git-quoted non-ASCII path, covers it as git lists it and names it decoded", () => {
    const quoted = "\\355\\225\\234\\352\\270\\200/package-lock.json";
    const header = `diff --git a/package-lock.json "b/${quoted}"\nsimilarity index 95%\nrename from package-lock.json\nrename to "${quoted}"\n`;
    const lines = Array.from({ length: 40 }, (_, index) => `    "node_modules/p${index}": "1.0.0",`);
    const section = modifiedSection("package-lock.json", lines, lines.map((line) => line.replace("1.0.0", "2.0.0")), header);
    const { chunks, omitted } = __testing.splitDiffs(
      [{ identity: IDENTITY, diff: section, files: [`"${quoted}"`] }],
      1_000,
      WORST_CASE_ROOM,
      new Map([[CANDIDATE_BLOB, lockfileText(5_000, 100)]]),
    );

    expect(omitted).toEqual([]);
    expect(chunks.flat()).toHaveLength(1);
    expect(chunks[0]![0]!.files).toEqual([`"${quoted}"`]);
    expect(chunks[0]![0]!.diff).toBe(section);
    expect(chunks[0]![0]!.lockfile).toMatch(/^Lockfile 한글\/package-lock\.json, modified, reviewed whole in this chunk:/);
  });

  it("gives a small lockfile a chunk of its own beside a small and an oversized file", () => {
    const lock = newFileSection("yarn.lock", lockfileText(400, 10));
    const app = "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const large = `diff --git a/large.ts b/large.ts\n${"z".repeat(3_000)}\n`;
    const split = __testing.splitDiffs([{ identity: IDENTITY, diff: lock + app + large, files: ["yarn.lock", "app.ts", "large.ts"] }], 1_000, 10_000);
    const packed = __testing.splitDiffs([{ identity: IDENTITY, diff: lock + app, files: ["yarn.lock", "app.ts"] }], 10_000, 10_000);

    for (const { chunks, omitted } of [split, packed]) {
      expect(omitted).toEqual([]);
      const holding = chunks.filter((chunk) => chunk.some((part) => part.files.includes("yarn.lock")));
      expect(holding.map((chunk) => chunk.flatMap((part) => part.files))).toEqual([["yarn.lock"]]);
      expect(holding[0]![0]!.diff).toBe(lock);
    }
  });

  it("still splits a large file that is not a lockfile exactly as before", () => {
    const header = "diff --git a/large.ts b/large.ts\n";
    const payload = `${Array.from({ length: 250 }, (_, index) => index.toString(36).padStart(4, "0")).join("")}\n`;
    const lock = newFileSection("yarn.lock", lockfileText(400, 10));
    const { chunks, omitted } = __testing.splitDiffs(
      [{ identity: IDENTITY, diff: `${header}${payload}${lock}`, files: ["large.ts", "yarn.lock"] }],
      100,
      1_000,
    );

    expect(omitted).toEqual([]);
    const capacity = 100 - header.length;
    const ranges = chunks.flat().filter((part) => part.files[0] === "large.ts");
    expect(ranges.map((part) => part.diff)).toEqual(
      Array.from({ length: Math.ceil(payload.length / capacity) }, (_, index) => `${header}${payload.slice(index * capacity, (index + 1) * capacity)}`),
    );
    expect(chunks.flat().filter((part) => part.files[0] === "yarn.lock").map((part) => part.diff)).toEqual([lock]);
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

const persistPassingVerification = (
  harness: ReturnType<typeof makeHarness>,
  run: { runId: string; contractDigest: string },
  snapshot: CandidateSnapshot,
): VerificationReport => {
  const snapshotDigest = candidateSnapshotDigest(snapshot);
  const repository = snapshot.repositories[0]!;
  const now = harness.clock.nowIso();
  const report: VerificationReport = {
    runId: run.runId,
    candidateSnapshotDigest: snapshotDigest,
    contractDigest: run.contractDigest,
    expectedInputs: 1,
    observedInputs: 1,
    results: [{
      commandId: "verify",
      repositoryIdentity: repository.identity,
      source: "local",
      exactHead: repository.candidateHead,
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      outputDigest: "sha256:test-verification-output",
      outputTruncated: false,
      status: "PASS",
      reasonCode: null,
    }],
    status: "PASS",
    reasonCode: ReasonCode.OK,
    gaps: [],
  };
  harness.cp.artifacts.putEvidence(harness.cp.evidenceWritersForTests().VERIFICATION, run.runId, "VERIFICATION", report, snapshotDigest);
  harness.cp.db.run(
    `INSERT OR REPLACE INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${snapshotDigest}:verify:${repository.identity}:local`,
      run.runId, snapshotDigest, "verify", repository.identity, "local", repository.candidateHead,
      now, now, 0, "sha256:test-verification-output", 0, "PASS", null,
    ],
  );
  return report;
};

/** A candidate that makes the passing change and writes `candidate` over a base holding `base`, frozen and verified. */
const prepareCandidate = async (candidate: Record<string, string>, base: Record<string, string> = {}) => {
  const harness = makeHarness();
  if (Object.keys(base).length > 0) {
    writeFiles(harness.repoPath, base);
    commitAll(harness.repoPath, "base files");
  }
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const workerSessionId = bindWorker(harness, task.taskId);
  const execution = harness.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  applyPassingChange(harness.repoPath);
  writeFiles(harness.repoPath, candidate);
  const head = commitAll(harness.repoPath, "candidate files");
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const frozen = await harness.cp.pipeline.freeze(run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const snapshot = frozen.value;
  const verification = persistPassingVerification(harness, run, snapshot);
  const blob = (revision: string, path: string): string =>
    execFileSync("git", ["-C", harness.repoPath, "rev-parse", `${revision}:${path}`], { encoding: "utf8", timeout: 30_000 }).trim();
  const invoke = () => harness.cp.review.controlPlaneInvoker()({
    runId: run.runId,
    projectId,
    executionMode: run.executionMode,
    snapshot,
    contract: CONTRACT,
    contractDigest: run.contractDigest,
    verification,
  });
  return { harness, identity, run, snapshot, head, blob, invoke };
};

/** A large ordinary file that makes the review chunked. */
const BIG = { "src/big.js": `// ${"y".repeat(130_000)}\n` };
const chunkPrompts = (setup: { harness: ReturnType<typeof makeHarness> }): string[] =>
  setup.harness.scripted.invocations.map((invocation) => invocation.prompt).filter((prompt) => /Review chunk/.test(prompt));

describe("a chunked review binds the whole lockfile to the candidate", () => {
  it("sends a live-size added lockfile whole and once to one chunk reviewer whose prompt names its path and candidate blob", async () => {
    const lockfile = lockfileText(155_291, 4_287);
    const setup = await prepareCandidate({ [LOCKFILE]: lockfile });
    try {
      setup.harness.scripted.script(
        { match: /Lockfile compositor\/package-lock\.json, added, reviewed whole/, text: reviewerPass([`${setup.identity}:${LOCKFILE}`]) },
        { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      expect(result.value).toMatchObject({ chunked: true, verdict: "PASS", omittedItems: [] });
      const holding = chunkPrompts(setup).filter((prompt) => prompt.includes(`diff --git a/${LOCKFILE} b/${LOCKFILE}`));
      expect(holding).toHaveLength(1);
      expect(holding[0]).toContain(lockfile.split("\n").slice(0, -1).map((line) => `+${line}\n`).join(""));
      expect(holding[0]!.split('"node_modules/p04000"')).toHaveLength(2);
      expect(holding[0]).toContain(
        `Lockfile ${LOCKFILE}, added, reviewed whole in this chunk: the patch below adds its full text, candidate blob ${setup.blob(setup.head, LOCKFILE)}`,
      );
    } finally {
      setup.harness.cp.close();
    }
  });

  it("sends a modified lockfile's full candidate text, read from the frozen candidate, with its patch and both blobs", async () => {
    const base = lockfileText(60_000, 1_500);
    const candidate = base.replace('"node_modules/p00002": "1.0.0"', '"node_modules/p00002": "2.0.0"');
    const setup = await prepareCandidate({ [LOCKFILE]: candidate, ...BIG }, { [LOCKFILE]: base });
    try {
      setup.harness.scripted.script(
        { match: /Lockfile compositor\/package-lock\.json, modified, reviewed whole/, text: reviewerPass([`${setup.identity}:${LOCKFILE}`]) },
        { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`, `${setup.identity}:src/big.js`]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      expect(result.value).toMatchObject({ chunked: true, verdict: "PASS", omittedItems: [] });
      const holding = chunkPrompts(setup).filter((prompt) => prompt.includes(`diff --git a/${LOCKFILE} b/${LOCKFILE}`));
      expect(holding).toHaveLength(1);
      expect(holding[0]).toContain(`\`\`\`text\n${candidate}\n\`\`\``);
      expect(holding[0]).toContain('"node_modules/p01400": "1.0.0",');
      expect(holding[0]).toContain('-    "node_modules/p00002": "1.0.0",\n+    "node_modules/p00002": "2.0.0",\n');
      expect(holding[0]).toContain(`candidate blob ${setup.blob(setup.head, LOCKFILE)}`);
      expect(holding[0]).toContain(`base blob ${setup.blob(setup.snapshot.repositories[0]!.baseHead, LOCKFILE)} as its complete patch`);
    } finally {
      setup.harness.cp.close();
    }
  });

  it("shows a modified lockfile in an unchunked review as its full candidate text and its patch, never the patch alone", async () => {
    const base = lockfileText(30_000, 700);
    const candidate = base.replace('"node_modules/p00002": "1.0.0"', '"node_modules/p00002": "2.0.0"');
    const setup = await prepareCandidate({ [LOCKFILE]: candidate }, { [LOCKFILE]: base });
    try {
      setup.harness.scripted.script({ match: /Candidate review/, text: reviewerPass([`${setup.identity}:${LOCKFILE}`, `${setup.identity}:src/app.js`]) });

      const result = await setup.invoke();

      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      expect(result.value).toMatchObject({ chunked: false, verdict: "PASS", omittedItems: [] });
      const prompts = setup.harness.scripted.invocations.map((invocation) => invocation.prompt);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(`\`\`\`text\n${candidate}\n\`\`\``);
      expect(prompts[0]).toContain('"node_modules/p00600": "1.0.0",');
      expect(prompts[0]).toContain('-    "node_modules/p00002": "1.0.0",\n+    "node_modules/p00002": "2.0.0",\n');
      expect(prompts[0]).toContain(`Lockfile ${LOCKFILE}, modified, reviewed whole in this chunk: its full candidate text follows, candidate blob ${setup.blob(setup.head, LOCKFILE)}`);
      expect(prompts[0]).toContain(`base blob ${setup.blob(setup.snapshot.repositories[0]!.baseHead, LOCKFILE)} as its complete patch`);
    } finally {
      setup.harness.cp.close();
    }
  });

  it("omits from an unchunked review a modified lockfile whose full text does not fit, and refuses PASS", async () => {
    const base = lockfileText(832_937, 20_000);
    const setup = await prepareCandidate({ [LOCKFILE]: base.replace('"node_modules/p00002": "1.0.0"', '"node_modules/p00002": "2.0.0"') }, { [LOCKFILE]: base });
    try {
      setup.harness.scripted.script({ match: /Candidate review/, text: reviewerPass([`${setup.identity}:${LOCKFILE}`, `${setup.identity}:src/app.js`]) });

      const result = await setup.invoke();

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
      const prompts = setup.harness.scripted.invocations.map((invocation) => invocation.prompt);
      expect(prompts.some((prompt) => prompt.includes(`diff --git a/${LOCKFILE}`))).toBe(false);
      const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
      expect(packet).toMatchObject({ verdict: "REVISE", chunked: false });
      expect(packet?.omittedItems).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(
          `^${setup.identity}:${LOCKFILE}: lockfile not reviewed: shown whole it needs \\d+ chars, more than the \\d+ chars one lockfile review chunk holds; a lockfile is not cut into ranges$`,
        )),
      ]));
    } finally {
      setup.harness.cp.close();
    }
  });

  it("omits the 832,937-byte modified lockfile by name with its reason, never calls it whole, and refuses PASS", async () => {
    const base = lockfileText(832_937, 20_000);
    const candidate = base.replace('"node_modules/p00002": "1.0.0"', '"node_modules/p00002": "2.0.0"');
    const setup = await prepareCandidate({ [LOCKFILE]: candidate, ...BIG }, { [LOCKFILE]: base });
    try {
      setup.harness.scripted.script(
        { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`, `${setup.identity}:src/big.js`]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
      expect(chunkPrompts(setup).some((prompt) => prompt.includes(`diff --git a/${LOCKFILE}`) || prompt.includes(`Lockfile ${LOCKFILE}`))).toBe(false);
      const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
      expect(packet?.verdict).toBe("REVISE");
      const reason = new RegExp(
        `^${setup.identity}:${LOCKFILE}: lockfile not reviewed: shown whole it needs (\\d+) chars, more than the \\d+ chars one lockfile review chunk holds; a lockfile is not cut into ranges$`,
      );
      const item = packet?.omittedItems.find((omitted) => reason.test(omitted));
      expect(Number(reason.exec(item ?? "")?.[1])).toBeGreaterThan(candidate.length);
    } finally {
      setup.harness.cp.close();
    }
  });

  it("recognises a lockfile git writes under a quoted non-ASCII path, and reviews it whole under its decoded path", async () => {
    const path = "한글/package-lock.json";
    const setup = await prepareCandidate({ [path]: lockfileText(155_291, 4_287) });
    // Required coverage names the path as the candidate snapshot lists it.
    const listed = setup.snapshot.repositories[0]!.touchedPaths.find((touched) => touched !== "src/app.js")!;
    try {
      setup.harness.scripted.script(
        { match: /Lockfile 한글\/package-lock\.json, added, reviewed whole/, text: reviewerPass([`${setup.identity}:${listed}`]) },
        { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      expect(result.value).toMatchObject({ chunked: true, verdict: "PASS", omittedItems: [] });
      expect(chunkPrompts(setup).filter((prompt) => prompt.includes(`Lockfile ${path}, added, reviewed whole`))).toHaveLength(1);
    } finally {
      setup.harness.cp.close();
    }
  });

  it("omits a lockfile over the cap by name with its reason, sends none of it, and refuses PASS", async () => {
    const setup = await prepareCandidate({ [LOCKFILE]: lockfileText(400_000, 10_000) });
    try {
      setup.harness.scripted.script(
        { match: /Review chunk|Candidate review/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
      const prompts = setup.harness.scripted.invocations.map((invocation) => invocation.prompt);
      expect(prompts.some((prompt) => prompt.includes(`diff --git a/${LOCKFILE}`))).toBe(false);
      const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
      expect(packet?.verdict).toBe("REVISE");
      expect(packet?.omittedItems).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(
          `^${setup.identity}:${LOCKFILE}: lockfile not reviewed: shown whole it needs \\d+ chars, more than the \\d+ chars one lockfile review chunk holds; a lockfile is not cut into ranges$`,
        )),
      ]));
    } finally {
      setup.harness.cp.close();
    }
  });
});
