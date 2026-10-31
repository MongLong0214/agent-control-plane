import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL, defaultProcessAncestryInspector } from "../../src/registry/canonical-self-claim.ts";
import { readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import { UNJUDGED_REVIEW_NOTICES } from "../../src/run/candidate-pipeline.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * F1 — what the owning CTO receives in band (role_dispatch_pending) when a review blocks the candidate without a
 * BLOCK verdict, or does not judge it at all. Every marker here is synthetic.
 */
type Args = Record<string, unknown>;
const MARKER = "SYNTHETIC-F1-REVIEWER-TEXT-3b9e";
const WORK_BRANCH = "feature/F1-delivery";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const START_TOKEN = "darwin-tv:1700000000.000000";
const SOURCE = "a synthetic private source the excerpt is cut from";
const EXCERPT = { originalSha256: sha256(SOURCE), omitted: true, ranges: [{ section: "result", startLine: 11, endLine: 12 }] };
const bundleFor = (runId: string, contractDigest: string): string => {
  const bytes = Buffer.from("## result\nsynthetic private excerpt\n", "utf8");
  return JSON.stringify({ runId, contractDigest, missing: ["the rest of the source"], files: [{ path: "handoff/excerpt.md", sha256: sha256(bytes),
    origin: "private handoff, synthetic", grade: "review-original", bodyBase64: bytes.toString("base64"), excerpt: EXCERPT }] });
};

/** A STANDARD run owned by an adopted canonical CTO, its one task done; `private` binds CEO-attached review evidence. */
async function fixture(kind: "private" | "plain") {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h);
  h.cp.providers.register(new TestProductionAdapter(h.clock, "claude"));
  // The canonical CTO's recorded process is this test process, under a synthetic start token its inspector reads back.
  const startToken = vi.spyOn(defaultProcessAncestryInspector, "readStartToken").mockImplementation((pid) => (pid === process.pid ? START_TOKEN : null));
  const owner = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: START_TOKEN });
  expect(h.cp.sessions.transition(owner.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: owner.sessionId, mode: "PREFERRED",
    authenticatedTarget: { claimed, protocolVersion: SELF_CLAIM_PROTOCOL, attestationDigest: digestOf({ fixture: "f1", sessionId: owner.sessionId }), verify: () => claimed } });
  if (!bound.allowed) throw new Error(bound.message);
  const ceo = bindCeo(h);
  const contract = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
    acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [] };
  const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  expect(run.ownerSessionId).toBe(owner.sessionId);
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({ runId: run.runId, taskId: impl.taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, impl.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${applyPassingChange(h.repoPath, WORK_BRANCH)}` });

  const lineage = digestOf("f1 lineage");
  const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId, lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const closers: Array<{ close(): Promise<void> }> = [];
  async function connect(as: "cto" | "hermes", sessionId: string) {
    const session = h.cp.sessions.require(sessionId);
    const auth = () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation });
    const server = as === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth) : createHermesServer(createHermesMcpPort(h.cp), auth, { provenance: anchor });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "f1-delivery", version: "1" });
    await client.connect(ct);
    closers.push(server, client);
    return async (name: string, args: Args): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: meta }, undefined, { timeout: 120_000 });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
  }
  const cto = await connect("cto", owner.sessionId);
  if (kind === "private") {
    const hermes = await connect("hermes", ceo);
    const evidenceBody = bundleFor(run.runId, run.contractDigest);
    const staged = await cto("review_evidence_stage", { idempotencyKey: "stage", runId: run.runId, contractDigest: run.contractDigest, evidenceBody,
      expectedSha256: sha256(evidenceBody) });
    expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true });
    const attached = await hermes("review_evidence_attach", { idempotencyKey: "attach", runId: run.runId, contractDigest: run.contractDigest,
      stagedBy: run.ownerRoleKey!, expectedSha256: sha256(evidenceBody) });
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
  }
  const review = (answer: Args) => h.scripted.script({ match: /Candidate review/, text: JSON.stringify({
    verdict: "PASS", coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [], ...answer }) });
  const submit = (key: string) => cto("result_submit", { idempotencyKey: key, runId: run.runId, resultSummary: "app returns 2", recommendation: "merge" });
  /** The REVISION_REQUESTs role_dispatch_pending lists for the owner, read over its own connection. */
  const delivered = async (): Promise<Array<{ messageId: string; runId: string; bindingGeneration: number; payload: Args }>> => {
    const body = await cto("role_dispatch_pending", {});
    expect(body).toMatchObject({ ok: true });
    return ((body["value"] as { messages: Array<Args & { kind: string }> }).messages)
      .filter((message) => message.kind === "REVISION_REQUEST") as never;
  };
  const revisionRows = () => h.cp.db.all<{ message_id: string; idempotency_key: string; target_session_id: string; binding_generation: number }>(
    "SELECT message_id, idempotency_key, target_session_id, binding_generation FROM outbox WHERE run_id = ? AND kind = 'REVISION_REQUEST'", [run.runId]);
  const stored = () => JSON.stringify(h.cp.db.all<Args>("SELECT * FROM inbound_messages"));
  const audited = () => JSON.stringify(h.cp.db.all<Args>("SELECT * FROM audit_events"));
  /** The round summary places the notice on its round as a notice; the round's outcome is what it was before F1. */
  const expectNoticeOnRound = (messageId: string, notice: string, outcome: string) => {
    const summary = summarizeReviewRounds(readReviewRoundSources(h.cp, run.runId));
    expect(summary.unattributedDeliveries).toEqual([]);
    expect(summary.rounds).toMatchObject([{ outcome, deliveries: [], notices: [{ messageId, notice }] }]);
  };
  return { h, run, identity, owner, ownerGeneration: bound.value.bindingGeneration, cto, review, submit, delivered, revisionRows, stored, audited, expectNoticeOnRound,
    close: async () => { for (const c of closers.reverse()) await c.close(); h.cp.close(); startToken.mockRestore(); } };
}

const blocker = (identity: string) => ({ category: "correctness", severity: "BLOCKER", repository: identity, path: "src/app.js",
  summary: `blocks: ${MARKER}`, detail: `blocker detail ${MARKER}` });

describe("F1 a PASS carrying a BLOCKER finding goes back to the owning CTO as a BLOCK does", () => {
  for (const kind of ["private", "plain"] as const) {
    it(`${kind} run: one REVISION_REQUEST in band with the blocker, bound to run, attempt, candidate and owner; the answer is unchanged`, async () => {
      const f = await fixture(kind);
      try {
        f.review({ findings: [blocker(f.identity)] });
        const answer = await f.submit("submit-blocker");
        expect(answer).toMatchObject({ ok: false, reasonCode: "REVIEW_BLOCK" });
        if (kind === "private") {
          expect(answer).toMatchObject({ evidence: { privateReviewEvidence: true, outcome: "NOT_COMPLETED", reasonCode: "REVIEW_BLOCK" } });
          expect(JSON.stringify(answer)).not.toContain(MARKER);
          expect(f.stored()).not.toContain(MARKER);
          expect(f.audited()).not.toContain(MARKER);
        } else {
          expect(answer).toMatchObject({ evidence: { blockers: [`blocks: ${MARKER}`] } });
        }

        const messages = await f.delivered();
        expect(messages).toHaveLength(1);
        const [message] = messages;
        expect(JSON.stringify(message!.payload)).toContain(`blocks: ${MARKER}`);
        const candidate = f.h.cp.runs.currentCandidate(f.run.runId)!;
        expect(message).toMatchObject({ runId: f.run.runId, bindingGeneration: f.ownerGeneration,
          payload: { runId: f.run.runId, reasonCode: "REVIEW_BLOCK", stage: "blind-review", candidateSnapshotDigest: candidate,
            packet: { verdict: "PASS", candidateSnapshotDigest: candidate, findings: [{ severity: "BLOCKER", summary: `blocks: ${MARKER}` }] } } });
        // The attempt that froze this candidate is the one the delivery is keyed by, to this exact owner session.
        const attempts = f.h.cp.db.all<{ attempt_id: string; candidate_digest: string }>(
          "SELECT attempt_id, candidate_digest FROM candidate_pipeline_attempts WHERE run_id = ?", [f.run.runId]);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]!.candidate_digest).toBe(candidate);
        expect(f.revisionRows()).toEqual([{ message_id: message!.messageId, target_session_id: f.owner.sessionId, binding_generation: f.ownerGeneration,
          idempotency_key: `revision:${f.run.runId}:${candidate}:REVIEW_BLOCK:${attempts[0]!.attempt_id}` }]);
        expect(f.h.cp.audit.forRun(f.run.runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")).toMatchObject([
          { reasonCode: "REVIEW_BLOCK", evidence: { stage: "blind-review", candidateSnapshotDigest: candidate, verdict: "PASS", findingsBySeverity: { BLOCKER: 1 } } }]);
      } finally { await f.close(); }
    });
  }

  it("a replay of the same submit delivers no second REVISION_REQUEST and needs no second ACK", async () => {
    const f = await fixture("private");
    try {
      f.review({ findings: [blocker(f.identity)] });
      const first = await f.submit("submit-blocker");
      const [message] = await f.delivered();
      expect(message).toBeDefined();
      expect(await f.cto("role_dispatch_ack", { messageId: message!.messageId })).toMatchObject({ ok: true });
      expect(await f.submit("submit-blocker")).toEqual(first);
      expect(f.revisionRows()).toHaveLength(1);
      expect(await f.delivered()).toEqual([]);
    } finally { await f.close(); }
  });

  it("a PASS whose findings hold no BLOCKER still completes and sends the owner nothing (rules unchanged)", async () => {
    const f = await fixture("private");
    try {
      f.review({ findings: [{ ...blocker(f.identity), severity: "MAJOR" }] });
      expect(await f.submit("submit-major")).toMatchObject({ ok: true, value: { outcome: "SUCCEEDED", stage: "COMPLETED_REVIEW" } });
      expect(f.revisionRows()).toEqual([]);
      expect(await f.delivered()).toEqual([]);
    } finally { await f.close(); }
  });
});

describe("F1 a review that did not judge the product tells the owning CTO so, with fixed text only", () => {
  for (const kind of ["private", "plain"] as const) {
    it(`${kind} run: a verdict on method findings alone gives the owner the fixed notice, its method findings private`, async () => {
      const f = await fixture(kind);
      try {
        f.review({ verdict: "REVISE", findings: [{ ...blocker(f.identity), category: "method", severity: "MAJOR", summary: `method: ${MARKER}` }] });
        const answer = await f.submit("submit-method");
        expect(answer).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: "REVIEW_REQUIRED" } });
        const messages = await f.delivered();
        expect(messages).toHaveLength(1);
        expect(messages).toMatchObject([{ runId: f.run.runId, bindingGeneration: f.ownerGeneration, payload: {
          reasonCode: "REVIEW_REQUIRED", stage: "review-unavailable", candidateSnapshotDigest: f.h.cp.runs.currentCandidate(f.run.runId),
          notice: "METHOD_FINDINGS_ONLY", recovery: UNJUDGED_REVIEW_NOTICES.METHOD_FINDINGS_ONLY,
          methodFindings: [{ category: "method", summary: `method: ${MARKER}` }] } }]);
        expect(messages[0]!.payload).not.toHaveProperty("packet");
        expect(f.h.cp.audit.forRun(f.run.runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")).toEqual([]);
        // A method-only round reads NO_OUTCOME_RECORDED, as on 688d0319: its completion and unavailable record conflict.
        f.expectNoticeOnRound(messages[0]!.messageId, "METHOD_FINDINGS_ONLY", "NO_OUTCOME_RECORDED");
        expect(JSON.stringify(answer)).not.toContain(MARKER);
        expect(f.stored()).not.toContain(MARKER);
        // A plain run's method findings are kept, as before, in their own dogfood record (#1271); a private run's are held.
        expect(f.h.cp.db.all<{ kind: string }>("SELECT kind FROM audit_events WHERE evidence_json LIKE ?", [`%${MARKER}%`]).map((row) => row.kind))
          .toEqual(kind === "private" ? [] : ["UPSTREAM_DOGFOOD_FINDING"]);
      } finally { await f.close(); }
    });

    it(`${kind} run: an unavailable review gives the owner the fixed notice and no reviewer text anywhere`, async () => {
      const f = await fixture(kind);
      try {
        f.h.scripted.script({ match: /Candidate review/, text: `not a verdict: ${MARKER}` });
        const answer = await f.submit("submit-unparsable");
        expect(answer).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: "EVIDENCE_MISSING" } });
        const messages = await f.delivered();
        expect(messages).toHaveLength(1);
        expect(messages).toEqual([{ ...messages[0], payload: { runId: f.run.runId, reasonCode: "EVIDENCE_MISSING", stage: "review-unavailable",
          candidateSnapshotDigest: f.h.cp.runs.currentCandidate(f.run.runId), notice: "REVIEW_UNAVAILABLE", recovery: UNJUDGED_REVIEW_NOTICES.REVIEW_UNAVAILABLE } }]);
        expect(messages[0]).toMatchObject({ runId: f.run.runId, bindingGeneration: f.ownerGeneration });
        f.expectNoticeOnRound(messages[0]!.messageId, "REVIEW_UNAVAILABLE", "REVIEW_UNAVAILABLE");
        expect(JSON.stringify(answer)).not.toContain(MARKER);
        expect(f.stored()).not.toContain(MARKER);
        expect(f.audited()).not.toContain(MARKER);
        // A replay of the same submit delivers nothing new.
        expect(await f.submit("submit-unparsable")).toEqual(answer);
        expect(f.revisionRows()).toHaveLength(1);
      } finally { await f.close(); }
    });
  }
});
