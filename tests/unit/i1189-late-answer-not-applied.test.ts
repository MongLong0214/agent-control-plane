import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { PRIVATE_EVIDENCE_ANSWER_NOTE } from "../../src/review/standard-review-evidence.ts";
import * as pipeline from "../../src/run/candidate-pipeline.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { type Harness, applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject, reviewerRevise } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 (a) — a submission whose attempt lost its lease while its review ran, and whose review then answered without
 * a verdict, is told in fixed text that nothing of it was applied. It is not an unavailable review of the current
 * candidate, it changes nothing, and a run with private review evidence keeps the same fixed text. Markers are synthetic.
 */
type Args = Record<string, unknown>;
const MINUTE = 60_000;
const MARKER = "SYNTHETIC-LATE-ANSWER-TEXT-5d21";
const WORK_BRANCH = "feature/late-answer";
const NOT_APPLIED = (pipeline as Record<string, unknown>)["STALE_ATTEMPT_NOT_APPLIED"];
const SOURCE = "a synthetic private source the excerpt is cut from";
const EXCERPT = { originalSha256: sha256(SOURCE), omitted: true, ranges: [{ section: "result", startLine: 11, endLine: 12 }] };
const bundleFor = (runId: string, contractDigest: string): string => {
  const bytes = Buffer.from(`## result\nsynthetic private excerpt ${MARKER}\n`, "utf8");
  return JSON.stringify({ runId, contractDigest, missing: ["the rest of the source"], files: [{ path: "handoff/excerpt.md", sha256: sha256(bytes),
    origin: "private handoff, synthetic", grade: "review-original", bodyBase64: bytes.toString("base64"), excerpt: EXCERPT }] });
};

/** A STANDARD run with its one task done; `private` binds CEO-attached review evidence to it first. */
async function fixture(kind: "private" | "plain") {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h);
  const ceo = bindCeo(h);
  const contract = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
    acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [] };
  const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const runId = run.runId;
  const tasks = h.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = h.cp.tasks.ready(runId)[0]!;
  const execution = h.cp.tasks.startExecution({ runId, taskId: impl.taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, impl.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${applyPassingChange(h.repoPath, WORK_BRANCH)}` });

  const closers: Array<{ close(): Promise<void> }> = [];
  if (kind === "private") {
    const lineage = digestOf("late answer lineage");
    const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
    const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId, lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
    const connect = async (as: "cto" | "hermes", sessionId: string) => {
      const session = h.cp.sessions.require(sessionId);
      const auth = () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation });
      const server = as === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth) : createHermesServer(createHermesMcpPort(h.cp), auth, { provenance: anchor });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "late-answer", version: "1" });
      await client.connect(ct);
      closers.push(server, client);
      return async (name: string, args: Args): Promise<Args> => {
        const result = await client.callTool({ name, arguments: args, _meta: meta }, undefined, { timeout: 120_000 });
        return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
      };
    };
    const cto = await connect("cto", run.ownerSessionId!);
    const hermes = await connect("hermes", ceo);
    const evidenceBody = bundleFor(runId, run.contractDigest);
    const staged = await cto("review_evidence_stage", { idempotencyKey: "stage", runId, contractDigest: run.contractDigest, evidenceBody,
      expectedSha256: sha256(evidenceBody) });
    expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true });
    const attached = await hermes("review_evidence_attach", { idempotencyKey: "attach", runId, contractDigest: run.contractDigest,
      stagedBy: run.ownerRoleKey!, expectedSha256: sha256(evidenceBody) });
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
  }

  const submit = () => h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "app returns 2", recommendation: "merge" });
  /** Every submission attempt's id, in freeze order. */
  const attempts = (): string[] => h.cp.audit.forRun(runId).filter((row) => row.kind === "CANDIDATE_FROZEN").map((row) => row.evidence["attemptId"] as string);
  const kinds = (kind: string) => h.cp.audit.forRun(runId).filter((row) => row.kind === kind);
  /** Everything a result could move: run state, candidate, verdicts, revisions, packets, every outbox message. */
  const productState = () => ({
    run: h.cp.db.get<Args>("SELECT state, state_reason, revision_count, current_candidate_digest FROM runs WHERE run_id = ?", [runId]),
    snapshots: h.cp.artifacts.list(runId, "CANDIDATE_SNAPSHOT").map((artifact) => artifact.digest),
    reviews: h.cp.artifacts.list(runId, "BLIND_REVIEW").map((artifact) => artifact.digest),
    packets: h.cp.artifacts.list(runId, "PRODUCTION_READY_PACKET").length,
    verdicts: kinds("BLIND_REVIEW_COMPLETED").length,
    returns: kinds("REVISION_RETURNED_TO_CTO").length,
    revisionTelemetry: h.cp.db.all<Args>("SELECT * FROM telemetry_metrics WHERE run_id = ? AND name = 'revision'", [runId]).length,
    outbox: h.cp.db.all<Args>("SELECT message_id, kind, idempotency_key, status FROM outbox WHERE run_id = ? ORDER BY message_id", [runId]),
  });
  const notices = () => h.cp.db.all<{ payload_json: string }>("SELECT payload_json FROM outbox WHERE run_id = ? AND kind = 'REVISION_REQUEST'", [runId])
    .map((row) => JSON.parse(row.payload_json) as Args);
  return { h, runId, identity, submit, attempts, kinds, productState, notices,
    close: async () => { for (const c of closers.reverse()) await c.close(); h.cp.close(); } };
}

/** The first candidate review waits until released; every later one answers at once. */
const holdFirstReview = (h: Harness) => {
  let entered!: () => void;
  const reviewing = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const invoke = h.scripted.invoke.bind(h.scripted);
  let calls = 0;
  h.scripted.invoke = async (request: InvocationRequest): Promise<InvocationResult> => {
    if (/Candidate review/.test(request.prompt) && ++calls === 1) {
      entered();
      await held;
    }
    return invoke(request);
  };
  return { reviewing, release };
};

/**
 * The first attempt's review outlasts its lease; a second attempt acquires the run (reclaiming the first) and is
 * returned for revision, its review taking the reviewer binding; then the first review answers, late.
 */
const lateAfterLostLease = async (f: Awaited<ReturnType<typeof fixture>>) => {
  f.h.scripted.script({ match: /Candidate review/, text: reviewerRevise([`${f.identity}:src/app.js`], `a finding ${MARKER}`), once: false });
  const { reviewing, release } = holdFirstReview(f.h);
  const first = f.submit();
  await reviewing;
  f.h.clock.advance(31 * MINUTE);
  const second = await f.submit();
  const before = f.productState();
  release();
  const late = await first;
  return { second, late, before, after: f.productState(), lateAttempt: f.attempts()[0]! };
};

describe("#1189 a late answer of an attempt that lost its lease says its result was not applied", () => {
  it("the answer is the fixed not-applied refusal with BINDING_GENERATION_STALE, and it changes no verdict, candidate, revision or outbox", async () => {
    const f = await fixture("plain");
    try {
      const { second, late, before, after, lateAttempt } = await lateAfterLostLease(f);

      expect(second).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
      // Not an unavailable review of the current candidate: a refusal that names the stale attempt and says not applied.
      expect(late).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE,
        evidence: { runId: f.runId, attemptId: lateAttempt, attemptHeld: false } });
      expect(late).not.toHaveProperty("value");
      expect(late.allowed ? null : late.message).toMatch(/not applied/);
      expect(typeof NOT_APPLIED).toBe("string");
      expect(late).toMatchObject({ message: NOT_APPLIED });
      // Fixed text only: no reviewer text, and no unconditional resubmit.
      expect(JSON.stringify(late)).not.toContain(MARKER);
      expect(String(NOT_APPLIED)).not.toMatch(/resubmit|result_submit|submit the result again/i);
      // Nothing of the late attempt reached the run; its failure stays its own history (#1189 R1-01).
      expect(after).toEqual(before);
      expect(f.notices().filter((payload) => payload["attemptId"] === lateAttempt)).toEqual([]);
      expect(f.kinds("BLIND_REVIEW_UNAVAILABLE").map((row) => row.evidence)).toMatchObject([{ attemptId: lateAttempt, attemptHeld: false }]);
    } finally { await f.close(); }
  });

  it("a genuine REVIEW_UNAVAILABLE of a held attempt is unchanged: its own detail, and its notice to the owner", async () => {
    const f = await fixture("plain");
    try {
      f.h.scripted.script({ match: /Candidate review/, text: `not a verdict: ${MARKER}` });

      const answer = await f.submit();

      expect(answer).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      const value = (answer.allowed ? answer.value : null) as { reasonCode: string; detail: { message: string } } | null;
      expect(value!.reasonCode).not.toBe(ReasonCode.BINDING_GENERATION_STALE);
      expect(value!.detail.message).not.toBe(NOT_APPLIED);
      expect(f.notices()).toMatchObject([{ stage: "review-unavailable", notice: "REVIEW_UNAVAILABLE", attemptId: f.attempts()[0], nextStep: "RESUBMIT" }]);
      expect(f.kinds("BLIND_REVIEW_UNAVAILABLE").map((row) => row.evidence)).toMatchObject([{ attemptId: f.attempts()[0] }]);
      expect(f.kinds("BLIND_REVIEW_UNAVAILABLE")[0]!.evidence).not.toHaveProperty("attemptHeld");
    } finally { await f.close(); }
  });

  it("a private-evidence run's late answer goes through privateEvidenceAnswer and keeps the fixed not-applied text", async () => {
    const f = await fixture("private");
    try {
      const { second, late, before, after } = await lateAfterLostLease(f);

      expect(second).toMatchObject({ allowed: true, value: { privateReviewEvidence: true, stage: "REVISION_REQUIRED" } });
      expect(late).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE,
        evidence: { privateReviewEvidence: true, outcome: "NOT_COMPLETED", reasonCode: ReasonCode.BINDING_GENERATION_STALE, runId: f.runId,
          note: PRIVATE_EVIDENCE_ANSWER_NOTE } });
      expect(late.allowed ? null : late.message).toMatch(/not applied/);
      expect(typeof NOT_APPLIED).toBe("string");
      expect(late).toMatchObject({ message: NOT_APPLIED });
      // The projection keeps ids, digests, counts and fixed enums only: no reviewer or bundle text.
      expect(JSON.stringify(late)).not.toContain(MARKER);
      expect(after).toEqual(before);
    } finally { await f.close(); }
  });
});
