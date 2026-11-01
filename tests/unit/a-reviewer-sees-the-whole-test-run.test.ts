import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import * as reviewEvidence from "../../src/review/candidate-review-evidence.ts";
import type { ExecutionEvidence, OutputEvidence } from "../../src/review/candidate-review-evidence.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import type { SandboxOutcome } from "../../src/verify/sandbox.ts";
import * as engine from "../../src/verify/verification-engine.ts";
import type { VerificationReport, VerificationResultRecord } from "../../src/verify/verification-engine.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject, reviewerPass } from "../helpers/harness.ts";

/*
 * Run A (run_b86c2fe6, myeotnyeon): VERIFICATION kept the head 1,000 and tail 3,000 characters of an
 * 18,978-character npm test stdout, so 91 of its 112 `ok` lines never reached the reviewer, and the
 * review BLOCKed for evidence it was never given. The whole redacted capture is now stored beside the
 * excerpt (acp.verification-output.v2), and the review delivers it whole, in labelled parts across
 * chunks when it does not fit one. The official command's process is stood in for: only what the engine
 * stores of its output and what the review delivers are under test.
 */

const sandbox = { stdout: "", stderr: "", truncated: false, fail: false };
vi.mock("../../src/verify/sandbox.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return { ...actual, runSandboxed: vi.fn(async (): Promise<SandboxOutcome> => ({
    status: sandbox.fail ? "FAIL" : "PASS", exitCode: sandbox.fail ? 1 : 0, signal: null, startedAt: "2026-11-01T00:00:00.000Z",
    endedAt: "2026-11-01T00:00:00.000Z", durationMs: 1, stdout: sandbox.stdout, stderr: sandbox.stderr,
    outputDigest: "sha256:fixture-capture", outputTruncated: sandbox.truncated, peakRssMb: 1,
    reasonCode: sandbox.fail ? ReasonCode.VERIFICATION_COMMAND_FAILED : null,
    enforcement: { worktreeIsolated: true, secretsStripped: true, networkPolicy: "deny",
      networkEnforced: true, writeConfinement: true, readConfinement: "sensitive-paths",
      processGroupKill: true, resourceLimitsEnforced: true, memoryLimit: "hard",
      childContainmentEnforced: true, childContainmentReason: null, mechanism: "seatbelt" },
  })) };
});

beforeEach(() => {
  sandbox.stdout = "";
  sandbox.stderr = "";
  sandbox.truncated = false;
  sandbox.fail = false;
});
afterAll(cleanupTempDirs);

const GITHUB_TOKEN_SHAPE = `ghp_${"A1b2C3d4".repeat(5)}`;
const LONG_BASE64 = "Ab9+/Zq7".repeat(10);
const SECRETS = [GITHUB_TOKEN_SHAPE, LONG_BASE64];
/** Every 8-character window of a secret: none may reach storage or a reviewer, whole or in pieces. */
const windows = (secret: string): string[] => Array.from({ length: secret.length - 7 }, (_, at) => secret.slice(at, at + 8));

/** A TAP stream of `count` result lines, each padded to `width`, ending in its plan and summary. */
const tap = (count: number, width: number): string => {
  const lines = Array.from({ length: count }, (_, index) => `ok ${index + 1} - tests/case-${String(index + 1).padStart(3, "0")}.test.js > passes `.padEnd(width, "."));
  return `TAP version 13\n${lines.join("\n")}\n1..${count}\n# tests ${count}\n# pass ${count}\n# fail 0\n`;
};
const resultLines = (count: number): RegExp[] => Array.from({ length: count }, (_, index) => new RegExp(`^ok ${index + 1} - `, "m"));

/** The fixture project's one official command (`verify`), run under the stand-in sandbox, then reviewed. */
const prepareRun = async () => {
  const harness = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["app returns 2"],
      priority: "NORMAL", humanGate: [], references: [] },
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
  const head = applyPassingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  return { harness, run, identity, head };
};

const runOfficial = async (script: (identity: string) => Array<{ match: RegExp; text: string; once?: boolean }>) => {
  const { harness, run, identity, head } = await prepareRun();
  harness.scripted.script(...script(identity));
  const outcome = await harness.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "app returns 2", recommendation: "merge" });
  const stored = harness.cp.artifacts.list<VerificationReport>(run.runId, "VERIFICATION").at(-1)?.content;
  const snapshot = harness.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT").at(-1)?.content;
  const prompts = harness.scripted.invocations.map((call) => call.prompt);
  return { harness, run, identity, head, outcome, stored, snapshot, prompts };
};

const STDOUT_KEY = (identity: string): string => `${identity}:#verification-output/verify/stdout`;

/** The output parts a prompt carries, read back from their heading, label and fence. */
const PART_LABEL = new RegExp(
  "^Official verification output, not a change of the candidate: part (\\d+) of (\\d+) of the (stdout|stderr) of command (\\S+) at ([0-9a-f]{40}), " +
    "characters \\[(\\d+), (\\d+)\\) of the (\\d+) kept after redaction, from line (\\d+)\\. ",
);
interface ShownPart { k: number; n: number; stream: string; start: number; end: number; total: number; line: number; label: string; text: string }
const partsIn = (prompt: string): ShownPart[] => {
  const parts: ShownPart[] = [];
  for (const heading of prompt.matchAll(/^- #verification-output\/verify\/(stdout|stderr)\n/gm)) {
    const rest = prompt.slice(heading.index! + heading[0].length);
    const label = rest.slice(0, rest.indexOf("\n"));
    const match = PART_LABEL.exec(label);
    expect(match, label).not.toBeNull();
    const afterLabel = rest.slice(label.length + 1);
    const fence = /^(`{3,})text\n/.exec(afterLabel)![1]!;
    const body = afterLabel.slice(fence.length + "text\n".length);
    const text = body.slice(0, body.indexOf(`\n${fence}`));
    const [, k, n, stream, , , start, end, total, line] = match!;
    parts.push({ k: Number(k), n: Number(n), stream: stream!, start: Number(start), end: Number(end), total: Number(total), line: Number(line), label, text });
  }
  return parts;
};

/** The execution evidence JSON a prompt carries. */
const executionIn = (prompt: string): { officialResults: { results: Array<Record<string, unknown>> } } =>
  JSON.parse(prompt.split("## Untrusted execution evidence\n")[1]!.split("```json\n")[1]!.split("\n```")[0]!) as { officialResults: { results: Array<Record<string, unknown>> } };

describe("witness 1: the reviewer receives every line of an official test run", () => {
  it("stores Run A's 18,978-character, 112-line stdout whole and redacted, and the reviewer reads every result line", async () => {
    const stdout = tap(112, 168);
    expect([stdout.length, stdout.match(/^ok \d+ - /gm)!.length]).toEqual([18_982, 112]);
    sandbox.stdout = stdout;
    const setup = await runOfficial((identity) => [
      { match: /Candidate review|Review chunk/, text: reviewerPass([`${identity}:src/app.js`, STDOUT_KEY(identity)]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    ]);
    try {
      expect(setup.outcome, JSON.stringify(setup.outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      // What the reviewers were given of the stream: the evidence section's text and any labelled parts.
      const reviewers = setup.prompts.filter((prompt) => !prompt.startsWith("# Final review"));
      const delivered = reviewers.flatMap((prompt) => [String(executionIn(prompt).officialResults.results[0]?.["stdout"] ?? ""),
        ...partsIn(prompt).map((part) => part.text)]).join("\n");
      for (const line of resultLines(112)) expect(delivered).toMatch(line);
      expect(delivered).toContain("# pass 112\n");
      // Stored whole beside the excerpt, which keeps only its head and tail as before.
      const result = setup.stored!.results[0]!;
      expect(result.output).toMatchObject({ schema: "acp.verification-output-excerpt.v1", truncated: true, stdoutChars: stdout.length });
      expect(result.capturedOutput).toMatchObject({ schema: "acp.verification-output.v2", stdoutChars: stdout.length, stdout,
        captureTruncated: false, redacted: false, outputDigest: result.outputDigest, exactHead: result.exactHead, commandId: "verify" });
    } finally { setup.harness.cp.close(); }
  }, 120_000);

  it("delivers an output too long for one chunk as labelled parts, one per chunk, that join back into the stored stream", async () => {
    // 112 result lines of about 2,200 characters each: about 250K characters, more than a review chunk holds.
    const stdout = tap(112, 2_200);
    sandbox.stdout = stdout;
    const setup = await runOfficial((identity) => [
      { match: /Candidate review|Review chunk/, text: reviewerPass([`${identity}:src/app.js`, STDOUT_KEY(identity)]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    ]);
    try {
      expect(setup.outcome, JSON.stringify(setup.outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const chunkPrompts = setup.prompts.filter((prompt) => prompt.startsWith("# Review chunk"));
      for (const prompt of chunkPrompts) expect(prompt.length).toBeLessThanOrEqual(120_000);
      const parts = chunkPrompts.flatMap(partsIn).sort((a, b) => a.k - b.k);
      expect(parts.length).toBeGreaterThanOrEqual(3);
      // Each part sits in one chunk; numbered 1..n, contiguous, the last completing the stream.
      expect(parts.map((part) => part.k)).toEqual(parts.map((_, index) => index + 1));
      for (const [index, part] of parts.entries()) {
        expect([part.n, part.stream, part.total]).toEqual([parts.length, "stdout", stdout.length]);
        expect(part.start).toBe(index === 0 ? 0 : parts[index - 1]!.end);
        expect(part.end - part.start).toBe(part.text.length);
        expect(part.line).toBe(stdout.slice(0, part.start).split("\n").length);
        expect(part.label).toContain(index === parts.length - 1 ? "This part completes the stream." : "This part does not complete the stream.");
      }
      expect(parts.at(-1)!.end).toBe(stdout.length);
      expect(parts.map((part) => part.text).join("")).toBe(setup.stored!.results[0]!.capturedOutput!.stdout);
      for (const line of resultLines(112)) expect(parts.map((part) => part.text).join("")).toMatch(line);
      // Every chunk also carries the bounded view in the evidence section, which names the parts' coverage item.
      for (const prompt of chunkPrompts) {
        const shown = executionIn(prompt).officialResults.results[0]!;
        expect(shown).toMatchObject({ outputRecord: "acp.verification-output.v2", truncated: true, wholeStreamParts: [STDOUT_KEY(setup.identity)] });
      }
      const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot!));
      expect(packet).toMatchObject({ verdict: "PASS", chunked: true, omittedItems: [] });
      expect(packet!.coveredFiles).toContain(STDOUT_KEY(setup.identity));
    } finally { setup.harness.cp.close(); }
  }, 240_000);

  it("an output part no chunk reviewer claims fails coverage, as an unclaimed file range does", async () => {
    sandbox.stdout = tap(112, 2_200);
    const setup = await runOfficial((identity) => [
      { match: /^Official verification output, not a change of the candidate: part 2 of /m, text: reviewerPass([`${identity}:src/app.js`]) },
      { match: /Review chunk/, text: reviewerPass([`${identity}:src/app.js`, STDOUT_KEY(identity)]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    ]);
    try {
      expect(setup.outcome, JSON.stringify(setup.outcome)).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
      const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot!));
      expect(packet?.verdict).toBe("REVISE");
      expect(packet?.omittedItems).toContain(STDOUT_KEY(setup.identity));
    } finally { setup.harness.cp.close(); }
  }, 240_000);
});

describe("witness 2: a capture cut at maxOutputBytes stays marked truncated, its cut edge withheld", () => {
  it("stores the cut explicitly with the limit, withholds the edge, and the review evidence and parts say so", async () => {
    const edge = "Ab9+/Zq7Ab9+/Zq7Ab";
    sandbox.stdout = `${tap(40, 120)}partial line before the cut ${edge}`;
    sandbox.truncated = true;
    const setup = await runOfficial(() => []);
    try {
      // A truncated capture is not passing evidence: the verification fails and no review runs.
      expect(setup.outcome, JSON.stringify(setup.outcome)).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
      expect(setup.prompts).toEqual([]);
      const result = setup.stored!.results[0]!;
      expect(result).toMatchObject({ outputTruncated: true, status: "ERROR" });
      const captured = result.capturedOutput!;
      expect(captured).toMatchObject({ schema: "acp.verification-output.v2", captureTruncated: true, maxOutputBytes: 1024 * 1024,
        stdoutChars: sandbox.stdout.length });
      expect(captured.stdout.endsWith("partial line before the cut ")).toBe(true);
      expect(JSON.stringify(setup.stored)).not.toContain(edge.slice(0, 8));

      // What a reviewer would be given of it: marked cut, the edge still withheld, the last part saying where the capture stopped.
      const snapshot = setup.snapshot!;
      const shown: OutputEvidence = reviewEvidence.outputEvidence({ snapshot, snapshotDigest: candidateSnapshotDigest(snapshot),
        contractDigest: setup.run.contractDigest, verification: setup.stored! }, result);
      expect(shown).toMatchObject({ output: "RETAINED", outputRecord: "acp.verification-output.v2", captureTruncated: true,
        boundaryFragmentWithheld: true, truncated: false, stdout: captured.stdout });
      const [stream] = reviewEvidence.outputStreamsInParts(evidenceOf([shown]), 0);
      const parts = reviewEvidence.outputStreamParts(stream!, 2_400);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.label).toContain("The capture stopped at the command's maxOutputBytes: the stream ends at that cut, the rest was never captured");
        expect(part.text).not.toContain(edge.slice(0, 8));
      }
      const section = reviewEvidence.executionEvidenceSection(evidenceOf([shown]), 0).lines.join("\n");
      expect(section).toContain("captureTruncated still means the capture itself was cut");
    } finally { setup.harness.cp.close(); }
  }, 120_000);
});

const evidenceOf = (results: OutputEvidence[]): ExecutionEvidence => ({
  commandSource: "the pinned manifest", commands: [], results, repositories: [], receipts: [],
  receiptsNotListed: { outsideCandidateHistory: 0, notACandidateRepository: 0, noCommitReceipt: 0, overListLimit: 0, unchecked: 0 },
});

describe("witness 3: no credential is exposed after redaction, stored or delivered", () => {
  it("keeps every credential shape out of the stored record and every prompt, whole stream in labelled parts included", async () => {
    const lines = tap(112, 2_200).split("\n");
    // A credential every tenth result line, the rest of the line still padded past the part room.
    const stdout = lines.map((line, index) => (index % 10 === 3 ? `${line.slice(0, 1_000)} ${SECRETS[index % 2]} ${line.slice(1_000)}` : line)).join("\n");
    sandbox.stdout = stdout;
    sandbox.stderr = `warn: token ${GITHUB_TOKEN_SHAPE} in stderr\n`;
    const setup = await runOfficial((identity) => [
      { match: /Candidate review|Review chunk/, text: reviewerPass([`${identity}:src/app.js`, STDOUT_KEY(identity),
        `${identity}:#verification-output/verify/stderr`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    ]);
    try {
      expect(setup.outcome, JSON.stringify(setup.outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const captured = setup.stored!.results[0]!.capturedOutput!;
      expect(captured.redacted).toBe(true);
      expect(captured.stdout).toContain("[redacted]");
      const stored = JSON.stringify(setup.stored);
      const prompts = setup.prompts.join("\n");
      expect(setup.prompts.flatMap(partsIn).length).toBeGreaterThanOrEqual(3);
      for (const secret of SECRETS) {
        for (const piece of windows(secret)) {
          expect(stored).not.toContain(piece);
          expect(prompts).not.toContain(piece);
        }
      }
    } finally { setup.harness.cp.close(); }
  }, 240_000);

  it("a credential straddling a part boundary is redacted before the cut, so neither part holds any of it", () => {
    const capture = engine.verificationOutputCapture;
    const binding = { candidateSnapshotDigest: `sha256:${"1".repeat(64)}`, contractDigest: `sha256:${"2".repeat(64)}`, commandId: "verify",
      exactHead: "a".repeat(40), outputDigest: "sha256:fixture-capture", maxOutputBytes: 1024 * 1024 };
    // One line longer than a part: where the first cut falls in it when it holds no credential.
    const filler = (length: number): string => "- ".repeat(length).slice(0, length);
    const stream = (text: string): reviewEvidence.OutputStreamDelivery => ({ repository: "github:acme/fixture", commandId: "verify",
      exactHead: binding.exactHead, stream: "stdout", path: "#verification-output/verify/stdout", text, captureTruncated: false });
    const plain = reviewEvidence.outputStreamParts(stream(`${filler(6_000)}\n`), 2_400);
    const cut = plain[0]!.end;
    expect(plain.length).toBeGreaterThan(1);
    for (const secret of SECRETS) {
      for (const offset of [cut - secret.length + 1, cut - Math.floor(secret.length / 2), cut - 1]) {
        const raw = `${filler(offset)} ${secret} ${filler(6_000 - offset)}\n`;
        // Split raw, the cut would leave a piece of the credential on each side.
        expect(raw.slice(cut - 4, cut + 4).length).toBe(8);
        const stored = capture(binding, raw, "", false);
        expect(stored.redacted).toBe(true);
        const parts = reviewEvidence.outputStreamParts(stream(stored.stdout), 2_400);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.map((part) => part.text).join("")).toBe(stored.stdout);
        for (const piece of windows(secret)) {
          expect(stored.stdout).not.toContain(piece);
          for (const part of parts) expect(part.text).not.toContain(piece);
        }
      }
    }
  });
});

describe("witness 4: a stored v1 excerpt still reads and renders as before", () => {
  const binding = { candidateSnapshotDigest: `sha256:${"1".repeat(64)}`, contractDigest: `sha256:${"2".repeat(64)}`, commandId: "verify",
    repositoryIdentity: "github:acme/fixture", exactHead: "a".repeat(40) };
  const snapshot = { repositories: [{ identity: binding.repositoryIdentity, candidateHead: binding.exactHead }] } as unknown as CandidateSnapshot;
  const v1Only = (output: VerificationResultRecord["output"]): VerificationResultRecord => ({ commandId: "verify",
    repositoryIdentity: binding.repositoryIdentity, source: "local", exactHead: binding.exactHead, startedAt: "t", endedAt: "t", exitCode: 0,
    outputDigest: "sha256:o", outputTruncated: false, status: "PASS", reasonCode: null, output });
  const report = (result: VerificationResultRecord): VerificationReport => ({ runId: "run", candidateSnapshotDigest: binding.candidateSnapshotDigest,
    contractDigest: binding.contractDigest, expectedInputs: 1, observedInputs: 1, results: [result], status: "PASS", reasonCode: "OK", gaps: [] });

  it("reads a v1 excerpt into the same evidence, field for field and in the same order, and adds no whole-output statement or part", () => {
    const long = `HEAD-LINE\n${"x ".repeat(10_000)}\nTests 4 passed (4)\n`;
    const excerpt = engine.verificationOutputExcerpt(binding, long, "", false);
    const result = v1Only(excerpt);
    const shown = reviewEvidence.outputEvidence({ snapshot, snapshotDigest: binding.candidateSnapshotDigest, contractDigest: binding.contractDigest,
      verification: report(result) }, result);
    expect(Object.keys(shown)).toEqual(["commandId", "repositoryIdentity", "source", "exactHead", "status", "exitCode", "reasonCode",
      "candidateSnapshotDigest", "contractDigest", "outputDigest", "captureTruncated", "boundaryFragmentWithheld", "output", "statement",
      "stdoutChars", "stderrChars", "redacted", "truncated", "stdout", "stderr"]);
    expect(shown).toEqual({ commandId: "verify", repositoryIdentity: binding.repositoryIdentity, source: "local", exactHead: binding.exactHead,
      status: "PASS", exitCode: 0, reasonCode: null, candidateSnapshotDigest: binding.candidateSnapshotDigest, contractDigest: binding.contractDigest,
      outputDigest: "sha256:o", captureTruncated: false, boundaryFragmentWithheld: false, output: "RETAINED", statement: null,
      stdoutChars: long.length, stderrChars: 0, redacted: false, truncated: true, stdout: excerpt.stdout, stderr: "" });
    const section = reviewEvidence.executionEvidenceSection(evidenceOf([shown]), 24_000).lines.join("\n");
    expect(section).not.toContain("outputRecord");
    expect(section).not.toContain("wholeStreamParts");
    expect(section).not.toContain("Whole output:");
    expect(section).toContain(JSON.stringify(excerpt.stdout).slice(1, 200));
  });
});

describe("witness 5: the CTO is given the v1 excerpt only, as today", () => {
  /**
   * Today's bound: the excerpt keeps at most OUTPUT_EXCERPT_HEAD_CHARS + OUTPUT_EXCERPT_TAIL_CHARS of each
   * stream, plus its omission marker, so the report a CTO is handed does not grow with the output. The
   * allowance covers the report's other fields and JSON escaping.
   */
  const TODAYS_BOUND = 2 * (engine.OUTPUT_EXCERPT_HEAD_CHARS + engine.OUTPUT_EXCERPT_TAIL_CHARS + 64) + 4_000;

  it("a failing 18K run: result_submit and the REVISION_REQUEST carry the stored v1 excerpt, no capturedOutput, within that bound", async () => {
    const stdout = tap(112, 168);
    sandbox.stdout = stdout;
    sandbox.fail = true;
    const { harness, run } = await prepareRun();
    try {
      const session = harness.cp.sessions.require(run.ownerSessionId!);
      const response = await callCtoTool(harness, { sessionId: session.sessionId, incarnation: session.incarnation }, "result_submit",
        { idempotencyKey: "submit-18k-failing", runId: run.runId, resultSummary: "app returns 2", recommendation: "merge" });
      expect(response, JSON.stringify(response).slice(0, 600)).toMatchObject({ ok: true, value: { stage: "VERIFICATION_FAILED" } });

      // The stored record keeps the whole capture; the CTO is handed that report less it, the excerpt exactly as stored.
      const stored = harness.cp.artifacts.list<VerificationReport>(run.runId, "VERIFICATION").at(-1)!.content;
      expect(stored.results[0]!.capturedOutput).toMatchObject({ stdout, stdoutChars: stdout.length });
      const today = { ...stored, results: stored.results.map(({ capturedOutput: _captured, ...result }) => result) };
      expect(today.results[0]!.output).toMatchObject({ schema: "acp.verification-output-excerpt.v1", truncated: true, stdoutChars: stdout.length });

      const revisions = harness.cp.outbox.listByRun(run.runId).filter((message) => message.kind === "REVISION_REQUEST");
      expect(revisions).toHaveLength(1);
      const handed = { resultSubmit: (response["value"] as { report: unknown }).report, revisionRequest: (revisions[0]!.payload as { report: unknown }).report };
      for (const [where, report] of Object.entries(handed)) {
        expect(report, where).toEqual(today);
        expect(JSON.stringify(report), where).not.toContain("capturedOutput");
        expect(JSON.stringify(report).length, where).toBeLessThanOrEqual(TODAYS_BOUND);
      }
      expect(JSON.stringify(response)).not.toContain("capturedOutput");
      expect(JSON.stringify(response).length).toBeLessThanOrEqual(TODAYS_BOUND + 2_000);
      expect(TODAYS_BOUND).toBeLessThan(stdout.length);
    } finally { harness.cp.close(); }
  }, 120_000);
});
