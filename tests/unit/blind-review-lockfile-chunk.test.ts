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

describe("a lockfile is reviewed whole in its own chunk, never cut into ranges", () => {
  it("keeps a 155,291-byte lockfile like the live one whole in a chunk of its own", () => {
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
    expect(holding[0]![0]!.coverageTargets).toHaveLength(1);
    expect(chunks.flat().some((part) => part.files.includes("src/app.js") && part.diff === small)).toBe(true);
  });

  it("keeps the live-size lockfile whole under the cap beside the most metadata a chunk carries", () => {
    // The room the review gives a lockfile: the cap less about 84K of metadata and the 4,096-char envelope.
    const lock = newFileSection(LOCKFILE, lockfileText(155_291, 4_287));
    const { chunks, omitted } = __testing.splitDiffs(
      [{ identity: IDENTITY, diff: lock, files: [LOCKFILE] }],
      120_000 - 84_000 - 4_096,
      __testing.LOCKFILE_CHUNK_THRESHOLD_CHARS - 84_000 - 4_096,
    );

    expect(omitted).toEqual([]);
    expect(chunks.map((chunk) => chunk.map((part) => part.diff))).toEqual([[lock]]);
  });

  it("keeps a lockfile exactly at the cap whole and omits one a byte over, naming it and the reason", () => {
    const fits = newFileSection(LOCKFILE, lockfileText(150_000, 4_000));
    const over = newFileSection(LOCKFILE, lockfileText(150_001, 4_000));
    expect(over.length).toBe(fits.length + 1);
    const measured = __testing.splitDiffs([{ identity: IDENTITY, diff: fits, files: [LOCKFILE] }], 100_000, 1_000_000).chunks.flat()[0]!;
    const cap = measured.lockfileBinding!.length + fits.length;

    const atCap = __testing.splitDiffs([{ identity: IDENTITY, diff: fits, files: [LOCKFILE] }], 100_000, cap);
    expect(atCap.omitted).toEqual([]);
    expect(atCap.chunks.flat().map((part) => part.diff)).toEqual([fits]);

    const oneOver = __testing.splitDiffs([{ identity: IDENTITY, diff: over, files: [LOCKFILE] }], 100_000, cap);
    expect(oneOver.omitted).toEqual([
      `${IDENTITY}:${LOCKFILE}: lockfile not reviewed: its whole patch (${over.length} chars) exceeds the ` +
        `${cap - measured.lockfileBinding!.length} chars one lockfile review chunk holds; a lockfile is not cut into ranges`,
    ]);
    expect(oneOver.chunks.flat().some((part) => part.files.includes(LOCKFILE))).toBe(false);
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

/** A candidate that makes the passing change and adds `lockfile` at `LOCKFILE`, frozen and verified. */
const prepareLockfileCandidate = async (lockfile: string) => {
  const harness = makeHarness();
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
  writeFiles(harness.repoPath, { [LOCKFILE]: lockfile });
  const head = commitAll(harness.repoPath, "add the compositor lockfile");
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const frozen = await harness.cp.pipeline.freeze(run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const snapshot = frozen.value;
  const verification = persistPassingVerification(harness, run, snapshot);
  const candidateBlob = execFileSync("git", ["-C", harness.repoPath, "rev-parse", `${head}:${LOCKFILE}`], { encoding: "utf8", timeout: 30_000 }).trim();
  const invoke = () => harness.cp.review.controlPlaneInvoker()({
    runId: run.runId,
    projectId,
    executionMode: run.executionMode,
    snapshot,
    contract: CONTRACT,
    contractDigest: run.contractDigest,
    verification,
  });
  return { harness, identity, run, snapshot, candidateBlob, invoke };
};

describe("a chunked review binds the whole lockfile to the candidate", () => {
  it("sends a live-size lockfile whole to one chunk reviewer whose prompt names its path and candidate blob", async () => {
    const lockfile = lockfileText(155_291, 4_287);
    const setup = await prepareLockfileCandidate(lockfile);
    try {
      setup.harness.scripted.script(
        { match: /Lockfile compositor\/package-lock\.json, reviewed whole/, text: reviewerPass([`${setup.identity}:${LOCKFILE}`]) },
        { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );

      const result = await setup.invoke();

      if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
      expect(result.value).toMatchObject({ chunked: true, verdict: "PASS", omittedItems: [] });
      const prompts = setup.harness.scripted.invocations.map((invocation) => invocation.prompt).filter((prompt) => /Review chunk/.test(prompt));
      const holding = prompts.filter((prompt) => prompt.includes(`diff --git a/${LOCKFILE} b/${LOCKFILE}`));
      expect(holding).toHaveLength(1);
      expect(holding[0]).toContain(lockfile.split("\n").slice(0, -1).map((line) => `+${line}\n`).join(""));
      expect(holding[0]).toContain(`Lockfile ${LOCKFILE}, reviewed whole in this chunk: candidate blob ${setup.candidateBlob}`);
      expect(holding[0]).toContain(`base blob ${"0".repeat(setup.candidateBlob.length)}`);
    } finally {
      setup.harness.cp.close();
    }
  });

  it("omits a lockfile over the cap by name with its reason, sends none of it, and refuses PASS", async () => {
    const setup = await prepareLockfileCandidate(lockfileText(400_000, 10_000));
    try {
      setup.harness.scripted.script(
        { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
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
          `^${setup.identity}:${LOCKFILE}: lockfile not reviewed: its whole patch \\(\\d+ chars\\) exceeds the \\d+ chars one lockfile review chunk holds; a lockfile is not cut into ranges$`,
        )),
      ]));
    } finally {
      setup.harness.cp.close();
    }
  });
});
