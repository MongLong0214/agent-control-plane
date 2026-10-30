import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { ManualClock, type Clock } from "../../src/core/clock.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { credentialBearingField, prohibitedDurableField } from "../../src/db/audit.ts";
import { ArtifactKind, ExecutionMode, Role, RunState } from "../../src/domain/types.ts";
import { __testing as reviewTesting, type ReviewPacket } from "../../src/review/blind-review.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { ClaudeCliAdapter, CodexCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, InvocationResult, SessionHandle, SessionSpec, TransmittedInput } from "../../src/runtime/provider.ts";
import { BOOTSTRAP_REVIEW_RETRY_WAKE } from "../../src/runtime/provisioned-session-runtime.ts";
import { provisionReviewerCodexHome } from "../../src/runtime/reviewer-codex-home.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { bootstrapCoverageKeys } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  type Harness,
} from "../helpers/harness.ts";
import { TestProductionAdapter, testReviewerEgressEvidence } from "../helpers/production-adapter.ts";
import { scriptBootstrapOwner } from "../helpers/scripted-bootstrap-owner.ts";

afterEach(() => {
  vi.restoreAllMocks();
  __testing.setRunCli(null);
});
afterAll(cleanupTempDirs);
const homes: string[] = [];
afterAll(() => { for (const root of homes) rmSync(dirname(root), { recursive: true, force: true }); });

/**
 * The 2026-10-16 live GPT packet review (codex-cli 0.162.0) answered REVISE with findings shaped
 * {issue, requiredChange, severity: HIGH, target}: the PLAN-review prompt showed `findings: []` and
 * no finding shape, and the packet reviewer gets no response schema from the CLI. The gate refused
 * the answer as EVIDENCE_MISSING, and the deny carried 500 characters of it under `raw`, so the
 * audit allowlist refused the whole UNAVAILABLE evidence and the row lost its candidate link.
 *
 * The `exec --json` lines below are the shape codex-cli 0.162.0 printed against a local mock
 * Responses endpoint (`turn.completed.usage.reasoning_output_tokens`); the rollout-only settings
 * line (`reasoning_effort`) is included to show the adapter ignores it too. Every answer runs
 * through the packet reviewer's own parsing (CodexCliAdapter, with only runCli stubbed).
 */
const line = (value: unknown): string => JSON.stringify(value);
const usage = { input_tokens: 120, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 4 };
const codexStdout = (thread: string, answer: string): string => [
  line({ type: "thread.started", thread_id: thread }),
  line({ type: "turn.started" }),
  line({ type: "thread_settings_applied", thread_settings: { model: "gpt-6.1-sol", reasoning_effort: "xhigh" } }),
  line({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "synthetic reasoning summary" } }),
  line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: answer } }),
  line({ type: "turn.completed", usage }),
].join("\n");

/** Synthetic text in the live answer's shape; no field of it may reach the audit row. */
const OFF_SCHEMA_MARKER = "off-schema-reviewer-text";
const offSchemaAnswer = (coveredFiles: string[]): string => {
  const finding = {
    issue: `${OFF_SCHEMA_MARKER} ${"x".repeat(140)}`,
    requiredChange: "y".repeat(150),
    severity: "HIGH",
    target: "#operation/create",
  };
  return JSON.stringify({ verdict: "REVISE", coveredFiles, omittedItems: [], findings: [finding, finding] });
};
const standardRevise = (coveredFiles: string[], repository: string, path: string | null): string => JSON.stringify({
  verdict: "REVISE",
  coveredFiles,
  omittedItems: [],
  findings: [{ category: "correctness", severity: "MAJOR", repository, path, summary: "synthetic finding", detail: "synthetic detail" }],
});

/** The finding shape the packet reviewer is told to answer in: the gate's one verdict schema, rendered. */
const renderedSchema = (): string => JSON.stringify(reviewTesting.VERDICT_SCHEMA, null, 2);

/** Synthetic provider stderr, longer than the audit's 200-character bound for an unlisted field. */
const STDERR_MARKER = `synthetic-provider-diagnostic ${"q".repeat(400)}`;

/**
 * runCli at the spawn boundary. A handshake answers READY under a fresh thread id; each resume
 * answers the next queued answer (the last one repeats; a function is asked with the prompt) under
 * the thread it resumes, with the given exit, stderr and isolation result.
 */
const stubProvider = (
  answers: Array<string | ((prompt: string) => string)>,
  resumed: { exitCode?: number; stderr?: string; isolationEnforced?: boolean } = {},
) => {
  const prompts: string[] = [];
  let threads = 0;
  __testing.setRunCli(async (_file, args, options) => {
    const resume = args.includes("resume");
    const prompt = String(options.stdin ?? "");
    if (resume) prompts.push(prompt);
    const next = resume ? (answers.length > 1 ? answers.shift()! : answers[0]!) : "READY";
    return {
      stdout: resume
        ? codexStdout(String(args.at(-2)), typeof next === "function" ? next(prompt) : next)
        // The reviewer session id is taken from the thread id's leading digits, so those differ.
        : codexStdout(`01a1448e-${String(++threads).padStart(4, "0")}-7000-8000-000000000000`, "READY"),
      stderr: resume ? resumed.stderr ?? "" : "",
      exitCode: resume ? resumed.exitCode ?? 0 : 0,
      timedOut: false,
      isolationEnforced: resume ? resumed.isolationEnforced ?? true : true,
      egressEvidence: testReviewerEgressEvidence("gpt"),
    };
  });
  return { prompts };
};

/** Every durable table whose rows contain `marker`. */
const durableTablesContaining = (harness: Harness, marker: string): string[] =>
  harness.cp.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .map(({ name }) => name)
    .filter((name) => harness.cp.db.all(`SELECT * FROM "${name}"`).some((row) => JSON.stringify(row).includes(marker)));

/** A real CodexCliAdapter for the reviewer's session and invocation; the scripted base keeps capacity. */
class CodexPacketReviewer extends TestProductionAdapter {
  readonly supportsReviewerIsolation = true;
  readonly requiresReviewerProviderSessionProof = true;
  readonly supportsReviewerEffortAttestation = true;
  readonly results: InvocationResult[] = [];
  constructor(clock: Clock, private readonly real: CodexCliAdapter) { super(clock, "gpt"); }
  override async startSession(spec: SessionSpec): Promise<SessionHandle> {
    return spec.isolation ? this.real.startSession(spec) : super.startSession(spec);
  }
  override async invoke(request: InvocationRequest): Promise<InvocationResult> {
    if (!request.isolation) return super.invoke(request);
    const result = await this.real.invoke(request);
    this.results.push(result);
    return result;
  }
  override transmittedReviewerInput(request: Pick<InvocationRequest, "systemPrompt" | "prompt">): TransmittedInput {
    return this.real.transmittedReviewerInput(request);
  }
}

const CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: ["public api changes"],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** An authenticated default Codex home: shared by every reviewer session and never claimed, as live. */
const sharedCodexHome = (): string => {
  const home = join(tempDir("acp-codex-0162-user-"), ".codex");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "auth.json"), '{"synthetic":"placeholder"}', { mode: 0o600 });
  return home;
};

/** A private override home is claimed once; a chunked review needs a session per chunk, so it shares. */
const setup = (options: { shared?: boolean } = {}): { harness: Harness; reviewer: CodexPacketReviewer } => {
  const harness = makeHarness({ reviewer: { preferred: { provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" }, fallbacks: [] } });
  const root = options.shared ? null : provisionReviewerCodexHome();
  if (root) homes.push(root);
  const real = new CodexCliAdapter({
    clock: new ManualClock("2026-10-16T11:40:00.000Z"),
    capacityFile: join(tempDir("acp-codex-0162-"), "gpt.json"),
    binary: join(tempDir("acp-codex-0162-bin-"), "codex-stub"),
    ...(root ? { reviewerCodexHome: root } : { codexHome: sharedCodexHome() }),
  });
  const reviewer = new CodexPacketReviewer(harness.clock, real);
  harness.cp.providers.registerForRole(reviewer, Role.BLIND_REVIEWER);
  return { harness, reviewer };
};

const submit = async (harness: Harness, options: { large?: boolean } = {}) => {
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const run = dispatched.value;
  const tasks = harness.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = harness.cp.tasks.ready(runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: impl.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(harness, impl.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  let head = applyPassingChange(harness.repoPath);
  if (options.large) {
    // Over the single-context budget, so the gate reviews it in chunks.
    writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n` });
    head = commitAll(harness.repoPath, "large reviewed change");
  }
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const outcome = await harness.cp.pipeline.submitResult({
    runId,
    ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "app() now returns 2",
    recommendation: "merge",
  });
  return { runId, outcome };
};

const unavailableRows = (harness: Harness, runId: string) =>
  harness.cp.audit.byKind("BLIND_REVIEW_UNAVAILABLE").filter((row) => row.runId === runId);

/** What an UNAVAILABLE row for an unparsable answer may say: a fixed code, the candidate, structure. */
const expectBoundedUnavailable = (
  row: { reasonCode: string | null; evidence: Record<string, unknown> } | undefined,
  candidate: string,
  answer: string,
): void => {
  expect(row?.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  expect(row?.evidence).toMatchObject({
    candidateSnapshotDigest: candidate,
    answerDigest: sha256(answer),
    answerLength: answer.length,
  });
  expect(row?.evidence).not.toHaveProperty("auditEvidenceRejected");
  expect(row?.evidence).not.toHaveProperty("raw");
  const stored = JSON.stringify(row?.evidence);
  expect(stored).not.toContain(OFF_SCHEMA_MARKER);
  expect(stored).not.toContain("requiredChange");
};

describe("a codex-cli 0.162 packet review through the real candidate gate", () => {
  it("stores a schema-conforming REVISE as BLIND_REVIEW; no reasoning_* key reaches the result or the artifact", async () => {
    const { harness, reviewer } = setup();
    try {
      const { prompts } = stubProvider([standardRevise(["github:acme/fixture:src/app.js"], "github:acme/fixture", "src/app.js")]);
      const { runId, outcome } = await submit(harness);
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED", reasonCode: ReasonCode.REVIEW_REVISE } });
      const result = reviewer.results.at(-1)!;
      expect(result).toMatchObject({ ok: true, isolationAttested: true, effortAttested: true });
      expect(prohibitedDurableField(result)).toBeNull();
      const stored = harness.cp.artifacts.latest<Record<string, unknown>>(runId, ArtifactKind.BLIND_REVIEW);
      expect(stored?.content).toMatchObject({
        verdict: "REVISE",
        provider: "gpt",
        effort: "xhigh",
        findings: [{ category: "correctness", severity: "MAJOR", repository: "github:acme/fixture", path: "src/app.js", summary: "synthetic finding", detail: "synthetic detail" }],
      });
      expect(prohibitedDurableField(stored!.content)).toBeNull();
      expect(JSON.stringify(stored!.content)).not.toMatch(/reasoning_/);
      expect(unavailableRows(harness, runId)).toEqual([]);
      expect(prompts.at(-1)).toContain(renderedSchema());
    } finally {
      harness.cp.close();
    }
  });

  it("refuses an off-schema findings shape as a bounded EVIDENCE_MISSING row that keeps its candidate, never coerced into a verdict", async () => {
    const { harness } = setup();
    try {
      const answer = offSchemaAnswer(["github:acme/fixture:src/app.js"]);
      stubProvider([answer]);
      const { runId, outcome } = await submit(harness);
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.EVIDENCE_MISSING } });
      const frozen = (outcome as { value: { snapshotDigest: string } }).value.snapshotDigest;
      expect(frozen).toBe(harness.cp.runs.currentCandidate(runId));
      expect(harness.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
      const rows = unavailableRows(harness, runId);
      expect(rows).toHaveLength(1);
      expectBoundedUnavailable(rows[0], frozen, answer);
    } finally {
      harness.cp.close();
    }
  });

  it("refuses an off-schema chunk answer as bounded EVIDENCE_MISSING, never as a REVISE from its omissions", async () => {
    const { harness } = setup({ shared: true });
    try {
      const answer = offSchemaAnswer(["github:acme/fixture:src/app.js"]);
      const { prompts } = stubProvider([(prompt) => (/# Final review/.test(prompt)
        ? JSON.stringify({ verdict: "PASS", coveredFiles: [], omittedItems: [], findings: [] })
        : answer)]);
      const { runId, outcome } = await submit(harness, { large: true });
      expect(prompts[0]).toMatch(/# Review chunk 1 of /);
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.EVIDENCE_MISSING } });
      const frozen = (outcome as { value: { snapshotDigest: string } }).value.snapshotDigest;
      expect(harness.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
      expect(harness.cp.audit.byKind("REVISION_RETURNED_TO_CTO").filter((row) => row.runId === runId)).toEqual([]);
      const rows = unavailableRows(harness, runId);
      expect(rows).toHaveLength(1);
      expectBoundedUnavailable(rows[0], frozen, answer);
      expect(rows[0]!.evidence).toMatchObject({ problem: "VERDICT_UNPARSABLE", chunk: 1 });
    } finally {
      harness.cp.close();
    }
  });

  it("stores no provider stderr when an attested reviewer exits nonzero", async () => {
    const { harness } = setup();
    try {
      stubProvider([standardRevise(["github:acme/fixture:src/app.js"], "github:acme/fixture", "src/app.js")], { exitCode: 1, stderr: STDERR_MARKER });
      const { runId, outcome } = await submit(harness);
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.EVIDENCE_MISSING } });
      const frozen = (outcome as { value: { snapshotDigest: string } }).value.snapshotDigest;
      const rows = unavailableRows(harness, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.evidence).toMatchObject({ candidateSnapshotDigest: frozen, exitCode: 1, errorDigest: expect.stringMatching(/^sha256:/) });
      expect(rows[0]!.evidence["errorLength"]).toBeGreaterThan(200);
      expect(JSON.stringify(outcome)).not.toContain(STDERR_MARKER);
      expect(durableTablesContaining(harness, STDERR_MARKER)).toEqual([]);
    } finally {
      harness.cp.close();
    }
  });

  it("still refuses a reviewer invocation whose effort differs from the constituted session", async () => {
    const root = provisionReviewerCodexHome();
    homes.push(root);
    const packetRoot = tempDir("acp-codex-0162-effort-");
    const adapter = new CodexCliAdapter({
      clock: new ManualClock("2026-10-16T11:40:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"),
      binary: join(packetRoot, "codex-stub"),
      reviewerCodexHome: root,
    });
    stubProvider([JSON.stringify({ verdict: "PASS", coveredFiles: [], omittedItems: [], findings: [] })]);
    const isolation = { packetRoot, denyReadPaths: [], emptyEnvironment: true as const, network: "provider-only" as const, tools: "none" as const };
    const handle = await adapter.startSession({ model: "gpt-6.1-sol", effort: "xhigh", workdir: packetRoot, purpose: "blind-review", isolation });
    const result = await adapter.invoke({
      prompt: "Return the packet verdict.", workdir: packetRoot, timeoutMs: 5_000, model: "gpt-6.1-sol", effort: "high",
      readOnly: true, correlationId: "effort-mismatch", externalSessionId: handle.externalSessionId, isolation,
    });
    expect(result.ok).toBe(false);
    expect(result.isolationAttested).not.toBe(true);
    expect(result.effortAttested).not.toBe(true);
    await adapter.stopSession(handle);
  });

  it("leaves the durable filters unchanged: reasoning text, transcripts and credentials are still found", () => {
    expect(prohibitedDurableField({ findings: [{ reasoning: "synthetic chain of thought" }] })).toBe("reasoning");
    expect(prohibitedDurableField({ transcript: ["synthetic turn"] })).toBe("transcript");
    expect(prohibitedDurableField({ usage: { reasoning_output_tokens: 4 } })).toBe("reasoning_output_tokens");
    expect(credentialBearingField({ apiKey: "placeholder-not-a-secret" })).toBe("apiKey");
  });
});

/**
 * #1274 — the packet's reviewer-input digests are the digests of the bytes the Codex adapter writes
 * to the reviewer CLI's stdin: system instructions, separator and prompt. A digest of the prompt
 * alone left the instructions every reviewer received outside the record.
 */
describe("the stored reviewer-input digests are the digests of the bytes the Codex adapter sends", () => {
  it.each([false, true])("for every reviewer invocation of a review (chunked=%s)", async (large) => {
    const { harness } = setup({ shared: true });
    try {
      const { prompts } = stubProvider([(prompt) => JSON.stringify({
        verdict: "PASS",
        coveredFiles: /# Final review/.test(prompt) ? [] : ["github:acme/fixture:src/app.js"],
        omittedItems: [],
        findings: [],
      })]);
      const { runId, outcome } = await submit(harness, { large });
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      if (large) {
        expect(prompts.filter((prompt) => prompt.includes("# Review chunk ")).length).toBeGreaterThan(1);
        expect(prompts.at(-1)).toContain("# Final review");
      } else {
        expect(prompts).toHaveLength(1);
      }
      const packet = harness.cp.artifacts.latest<ReviewPacket>(runId, ArtifactKind.BLIND_REVIEW)!.content;
      expect(packet.inputManifest.reviewerPromptDigests).toEqual(prompts.map((sent) => sha256(Buffer.from(sent, "utf8"))));
      expect(packet.inputManifest.reviewerInputRepresentations).toEqual(prompts.map(() => "stdin"));
    } finally {
      harness.cp.close();
    }
  });
});

/** A real ClaudeCliAdapter for the reviewer's invocation and its declared input; the scripted base keeps capacity. */
class ClaudePacketReviewer extends TestProductionAdapter {
  readonly supportsReviewerIsolation = true;
  constructor(clock: Clock, private readonly real: ClaudeCliAdapter) { super(clock, "claude"); }
  override async startSession(spec: SessionSpec): Promise<SessionHandle> {
    return spec.isolation ? this.real.startSession(spec) : super.startSession(spec);
  }
  override async invoke(request: InvocationRequest): Promise<InvocationResult> {
    return request.isolation ? this.real.invoke(request) : super.invoke(request);
  }
  override transmittedReviewerInput(request: Pick<InvocationRequest, "systemPrompt" | "prompt">): TransmittedInput {
    return this.real.transmittedReviewerInput(request);
  }
}

/**
 * runCli at the Claude CLI's spawn boundary: records the `--append-system-prompt` argv value and the
 * stdin of every call, and answers in the `--output-format json` envelope under the session it was given.
 */
const stubClaude = (answer: (prompt: string) => string) => {
  const sent: Array<{ systemPrompt: string | undefined; stdin: string }> = [];
  __testing.setRunCli(async (_file, args, options) => {
    const stdin = String(options.stdin ?? "");
    const system = args.indexOf("--append-system-prompt");
    sent.push({ systemPrompt: system === -1 ? undefined : args[system + 1], stdin });
    const session = args[Math.max(args.indexOf("--session-id"), args.indexOf("--resume")) + 1];
    return {
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer(stdin), session_id: session }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isolationEnforced: true,
      egressEvidence: testReviewerEgressEvidence("claude"),
    };
  });
  return { sent };
};

/**
 * #1274 — the Claude fallback sends the system instructions as the `--append-system-prompt` argv value
 * and the prompt on stdin. Each stored digest covers those two values as passed, joined by NUL (which
 * no argv value can contain), and the packet names that representation beside it.
 */
describe("the stored reviewer-input digests are the digests of what the Claude adapter passes", () => {
  it.each([false, true])("argv system prompt and stdin prompt, for every reviewer invocation (chunked=%s)", async (large) => {
    const harness = makeHarness({ reviewer: { preferred: { provider: "claude", model: "opus", effort: null }, fallbacks: [] } });
    const real = new ClaudeCliAdapter({
      clock: new ManualClock("2026-10-30T00:00:00.000Z"),
      capacityFile: join(tempDir("acp-1274-claude-"), "claude.json"),
      binary: join(tempDir("acp-1274-claude-bin-"), "claude-stub"),
    });
    harness.cp.providers.registerForRole(new ClaudePacketReviewer(harness.clock, real), Role.BLIND_REVIEWER);
    try {
      const { sent } = stubClaude((prompt) => JSON.stringify({
        verdict: "PASS",
        coveredFiles: /# Final review/.test(prompt) ? [] : ["github:acme/fixture:src/app.js"],
        omittedItems: [],
        findings: [],
      }));
      const { runId, outcome } = await submit(harness, { large });
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      if (large) {
        expect(sent.filter(({ stdin }) => stdin.includes("# Review chunk ")).length).toBeGreaterThan(1);
        expect(sent.at(-1)!.stdin).toContain("# Final review");
      } else {
        expect(sent).toHaveLength(1);
      }
      for (const call of sent) expect(call.systemPrompt).toBeTruthy();
      const packet = harness.cp.artifacts.latest<ReviewPacket>(runId, ArtifactKind.BLIND_REVIEW)!.content;
      expect(packet.inputManifest.reviewerPromptDigests).toEqual(
        sent.map(({ systemPrompt, stdin }) => sha256(Buffer.from(`${systemPrompt}\u0000${stdin}`, "utf8"))),
      );
      expect(packet.inputManifest.reviewerInputRepresentations).toEqual(sent.map(() => "argv --append-system-prompt + stdin"));
    } finally {
      harness.cp.close();
    }
  });

  it("refuses a reviewer whose adapter does not declare what it transmits, before it is asked", async () => {
    const harness = makeHarness({ reviewer: { preferred: { provider: "claude", model: "opus", effort: null }, fallbacks: [] } });
    const real = new ClaudeCliAdapter({
      clock: new ManualClock("2026-10-30T00:00:00.000Z"),
      capacityFile: join(tempDir("acp-1274-claude-"), "claude.json"),
      binary: join(tempDir("acp-1274-claude-bin-"), "claude-stub"),
    });
    const reviewer = new ClaudePacketReviewer(harness.clock, real);
    Object.defineProperty(reviewer, "transmittedReviewerInput", { value: undefined });
    harness.cp.providers.registerForRole(reviewer, Role.BLIND_REVIEWER);
    try {
      const { sent } = stubClaude(() => JSON.stringify({ verdict: "PASS", coveredFiles: [], omittedItems: [], findings: [] }));
      const { runId, outcome } = await submit(harness);
      expect(outcome).toMatchObject({
        allowed: true,
        value: {
          stage: "REVIEW_UNAVAILABLE",
          reasonCode: ReasonCode.EVIDENCE_MISSING,
          detail: { message: "reviewer adapter does not declare the input it transmits" },
        },
      });
      expect(sent).toHaveLength(0);
      expect(harness.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
    } finally {
      harness.cp.close();
    }
  });
});

/**
 * The bootstrap PLAN review, as live: the fixture's GPT provider routes its packet reviewer to a real
 * CodexCliAdapter on an authenticated default home (shared, never claimed), and every review is the
 * gate's own, reached through the owner's `result_submit` on the real CTO socket.
 */
describe("an off-schema bootstrap PLAN review keeps its candidate, so the official retry recognises it", () => {
  const REVIEWER = { preferred: { provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" }, fallbacks: [] };
  const harnessOptions = { reviewer: REVIEWER };

  const routeToCodex = (f: BootstrapRuntimeFixture) => {
    const codex = new CodexCliAdapter({
      clock: new ManualClock("2026-10-16T11:40:00.000Z"),
      capacityFile: join(tempDir("acp-codex-0162-capacity-"), "gpt.json"),
      binary: process.execPath,
      codexHome: sharedCodexHome(),
    });
    f.harness.cp.review.attach({ packetReviewerScope: (provider) => provider === "gpt" ? codex.packetReviewerScope() : null });
    const start = f.gpt.startSession.bind(f.gpt);
    const invoke = f.gpt.invoke.bind(f.gpt);
    let reviews = 0;
    vi.spyOn(f.gpt, "startSession").mockImplementation(async (spec: SessionSpec) =>
      spec.isolation ? codex.startSession(spec) : start(spec));
    vi.spyOn(f.gpt, "invoke").mockImplementation(async (request: InvocationRequest) => {
      if (!request.isolation) return invoke(request);
      reviews += 1;
      return codex.invoke(request);
    });
    return { reviews: () => reviews };
  };

  const runningRun = (f: BootstrapRuntimeFixture): string =>
    f.harness.cp.db.get<{ run_id: string }>(`SELECT run_id FROM candidate_pipeline_attempts WHERE state = 'RUNNING' LIMIT 1`)!.run_id;
  const offSchemaNow = (f: BootstrapRuntimeFixture) => () => offSchemaAnswer(bootstrapCoverageKeys(f.harness, runningRun(f)));
  const reviseNow = (f: BootstrapRuntimeFixture) => () => {
    const keys = bootstrapCoverageKeys(f.harness, runningRun(f));
    return standardRevise(keys, keys[0]!.split(":#")[0]!, null);
  };

  const auditOf = (f: BootstrapRuntimeFixture, kind: string, runId: string) =>
    f.harness.cp.audit.byKind(kind).filter((row) => row.runId === runId);

  /** A run whose owner planned on RUN_DISPATCH and submitted its result; the review answered off-schema. */
  const unavailableOffSchema = async (
    f: BootstrapRuntimeFixture,
    later: Array<string | (() => string)>,
    onRetry: "follow-prompt" | "ignore" = "follow-prompt",
  ) => {
    const reviewer = routeToCodex(f);
    let answered: string | null = null;
    const first = offSchemaNow(f);
    const provider = stubProvider([() => (answered = first()), ...later]);
    const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onRevision: "ignore", onResult: "follow-prompt", onRetry });
    const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
    await vi.waitFor(() => expect(owner.results).toHaveLength(1), { timeout: 10_000, interval: 25 });
    await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false), { timeout: 10_000, interval: 25 });
    expect(owner.results).toEqual([{ runId, ok: true, stage: "REVIEW_UNAVAILABLE" }]);
    const candidate = f.harness.cp.runs.currentCandidate(runId)!;
    const rows = auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId);
    expect(rows).toHaveLength(1);
    expectBoundedUnavailable(rows[0], candidate, answered!);
    expect(provider.prompts[0]).toContain(renderedSchema());
    expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
    return { reviewer, provider, owner, runId, ownerSessionId, roleKey, candidate, unavailableEventId: rows[0]!.eventId };
  };

  it("wakes the owner exactly once, and the retried review of the same candidate stores a standard REVISE", async () => {
    await withBootstrapRuntime(async (f) => {
      const { reviewer, owner, runId, ownerSessionId, roleKey, candidate, unavailableEventId } =
        await unavailableOffSchema(f, [reviseNow(f)]);
      const planDigest = f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest;
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({
        woken: [{ runId, roleKey, bindingGeneration: 1, planDigest, retry: { candidateSnapshotDigest: candidate, unavailableEventId } }],
      });
      await vi.waitFor(() => expect(owner.results).toHaveLength(2), { timeout: 10_000, interval: 25 });
      expect(owner.results.at(-1)).toEqual({ runId, ok: true, stage: "REVISION_REQUIRED" });
      expect(reviewer.reviews()).toBe(2);
      expect(f.harness.cp.runs.currentCandidate(runId)).toBe(candidate);
      expect(f.harness.cp.review.latestPacket(runId, candidate)).toMatchObject({ verdict: "REVISE", provider: "gpt", findings: [{ category: "correctness" }] });
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId)).toHaveLength(1);
    }, harnessOptions);
  });

  it("an already-spent retry gets no extra run when the retried review is off-schema again", async () => {
    await withBootstrapRuntime(async (f) => {
      const { reviewer, owner, runId, ownerSessionId, candidate } = await unavailableOffSchema(f, [offSchemaNow(f)]);
      expect(f.daemon.wakeBootstrapResultRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(owner.results).toHaveLength(2), { timeout: 10_000, interval: 25 });
      expect(owner.results.at(-1)).toMatchObject({ stage: "REVIEW_UNAVAILABLE" });
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      const rows = auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId);
      expect(rows.map((row) => row.evidence["candidateSnapshotDigest"])).toEqual([candidate, candidate]);
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId)).toHaveLength(1);
      expect(reviewer.reviews()).toBe(2);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    }, harnessOptions);
  });

  it("an isolation failure with long provider stderr keeps its candidate, is retried once, and stores no stderr", async () => {
    await withBootstrapRuntime(async (f) => {
      const reviewer = routeToCodex(f);
      stubProvider([offSchemaNow(f)], { exitCode: 1, stderr: STDERR_MARKER, isolationEnforced: false });
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onRevision: "ignore", onResult: "follow-prompt", onRetry: "follow-prompt" });
      const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(owner.results).toHaveLength(1), { timeout: 10_000, interval: 25 });
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      expect(owner.results).toEqual([{ runId, ok: true, stage: "REVIEW_UNAVAILABLE" }]);
      const candidate = f.harness.cp.runs.currentCandidate(runId)!;
      const rows = auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
      expect(rows[0]!.evidence).toMatchObject({ candidateSnapshotDigest: candidate, isolationDetailDigest: expect.stringMatching(/^sha256:/) });
      expect(rows[0]!.evidence["isolationDetailLength"]).toBeGreaterThan(200);
      expect(rows[0]!.evidence).not.toHaveProperty("auditEvidenceRejected");
      const planDigest = f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest;
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({
        woken: [{ runId, roleKey, bindingGeneration: 1, planDigest, retry: { candidateSnapshotDigest: candidate, unavailableEventId: rows[0]!.eventId } }],
      });
      await vi.waitFor(() => expect(owner.results).toHaveLength(2), { timeout: 10_000, interval: 25 });
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      expect(owner.results.at(-1)).toMatchObject({ stage: "REVIEW_UNAVAILABLE" });
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId)).toHaveLength(1);
      expect(reviewer.reviews()).toBe(2);
      expect(durableTablesContaining(f.harness, STDERR_MARKER)).toEqual([]);
    }, harnessOptions);
  });

  it("a stale candidate gets no retry: once its PLAN is replaced, the unavailable review is not re-run", async () => {
    await withBootstrapRuntime(async (f) => {
      const { reviewer, runId, ownerSessionId, candidate } = await unavailableOffSchema(f, [offSchemaNow(f)], "ignore");
      const plan = f.harness.cp.artifacts.latest<Record<string, unknown>>(runId, ArtifactKind.PLAN)!;
      const replaced = await f.cto(ownerSessionId, "plan_submit", {
        runId,
        plan: { ...plan.content, summary: `${String(plan.content["summary"])}; revised` },
        tasks: [{ key: "bootstrap", title: "create the repository", category: "implementation" }],
      });
      expect(replaced, JSON.stringify(replaced)).toMatchObject({ ok: true });
      expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest).not.toBe(plan.digest);
      const report = f.daemon.wakeBootstrapResultRecovery();
      expect(report.woken.every((woken) => !("retry" in woken))).toBe(true);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId)).toHaveLength(0);
      expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
      expect(auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId).map((row) => row.evidence["candidateSnapshotDigest"])).toEqual([candidate]);
      expect(reviewer.reviews()).toBe(1);
    }, harnessOptions);
  });
});
