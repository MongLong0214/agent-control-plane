import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import type { RoleBinding } from "../../src/domain/types.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL, defaultProcessAncestryInspector } from "../../src/registry/canonical-self-claim.ts";
import { readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import * as pipeline from "../../src/run/candidate-pipeline.ts";
import { UNJUDGED_REVIEW_NOTICES } from "../../src/run/candidate-pipeline.ts";
import * as driven from "../../src/runtime/provisioned-session-runtime.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
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
  /** Every submission attempt's id, in freeze order (the CANDIDATE_FROZEN rows the pipeline stamps). */
  const attempts = (): string[] => h.cp.audit.forRun(run.runId).filter((row) => row.kind === "CANDIDATE_FROZEN")
    .map((row) => row.evidence["attemptId"] as string);
  /** Everything product-side a revision could move: run state and revision count, PLAN, tasks, candidate, revision telemetry. */
  const productState = () => ({
    run: h.cp.db.get<Args>("SELECT state, state_reason, revision_count, current_candidate_digest FROM runs WHERE run_id = ?", [run.runId]),
    plans: h.cp.artifacts.list(run.runId, "PLAN").map((artifact) => artifact.digest),
    tasks: h.cp.tasks.list(run.runId).map((task) => [task.taskId, task.state]),
    revisionTelemetry: h.cp.db.all<Args>("SELECT * FROM telemetry_metrics WHERE run_id = ? AND name = 'revision'", [run.runId]).length,
    returns: h.cp.audit.forRun(run.runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO").length,
  });
  /** The payloads of every REVISION_REQUEST role_dispatch_pending lists for the owner, oldest first. */
  const notices = async (): Promise<Args[]> => (await delivered()).map((message) => message.payload);
  /** The round summary places the notice on its round as a notice; the round's outcome is what it was before F1. */
  const expectNoticeOnRound = (messageId: string, notice: string, outcome: string) => {
    const summary = summarizeReviewRounds(readReviewRoundSources(h.cp, run.runId));
    expect(summary.unattributedDeliveries).toEqual([]);
    expect(summary.rounds).toMatchObject([{ outcome, deliveries: [], notices: [{ messageId, notice }] }]);
  };
  return { h, run, identity, owner, ownerGeneration: bound.value.bindingGeneration, cto, review, submit, delivered, revisionRows, stored, audited, expectNoticeOnRound, attempts, productState, notices,
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
          notice: "METHOD_FINDINGS_ONLY", unjudgedAttempts: 1, unjudgedAttemptLimit: 2, nextStep: "RESUBMIT",
          recovery: `${UNJUDGED_REVIEW_NOTICES.METHOD_FINDINGS_ONLY} ${pipeline.UNJUDGED_REVIEW_NEXT_STEPS?.RESUBMIT}`,
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
          candidateSnapshotDigest: f.h.cp.runs.currentCandidate(f.run.runId), attemptId: f.attempts().at(-1), notice: "REVIEW_UNAVAILABLE",
          unjudgedAttempts: 1, unjudgedAttemptLimit: 2, nextStep: "RESUBMIT",
          recovery: `${UNJUDGED_REVIEW_NOTICES.REVIEW_UNAVAILABLE} ${pipeline.UNJUDGED_REVIEW_NEXT_STEPS?.RESUBMIT}` } }]);
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

describe("F1 an unjudged-review notice changes nothing product-side and its recovery is bounded", () => {
  const unavailable = (f: Awaited<ReturnType<typeof fixture>>) => f.h.scripted.script({ match: /Candidate review/, text: `not a verdict: ${MARKER}` });

  it("receiving and acknowledging the notice moves no run state, revision count, PLAN, task, candidate or revision telemetry", async () => {
    const f = await fixture("plain");
    try {
      const before = f.productState();
      unavailable(f);
      expect(await f.submit("submit-unavailable")).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      const afterSubmit = f.productState();
      const [notice] = await f.delivered();
      expect(notice).toBeDefined();
      // Only the candidate the submission froze is new; nothing else a revision would move has moved.
      expect({ ...afterSubmit, run: { ...afterSubmit.run, current_candidate_digest: null } })
        .toEqual({ ...before, run: { ...before.run, current_candidate_digest: null } });
      expect(afterSubmit.run).toMatchObject({ state: "ACTIVE", revision_count: 0 });
      expect(await f.cto("role_dispatch_ack", { messageId: notice!.messageId })).toMatchObject({ ok: true });
      expect(f.productState()).toEqual(afterSubmit);
      expect(await f.delivered()).toEqual([]);
    } finally { await f.close(); }
  });

  it("counts unjudged attempts in a row on the unchanged candidate; at the limit the next step is escalation; a replay adds nothing", async () => {
    const f = await fixture("plain");
    try {
      const step = (next: "RESUBMIT" | "ESCALATE") =>
        `${UNJUDGED_REVIEW_NOTICES.REVIEW_UNAVAILABLE} ${(pipeline.UNJUDGED_REVIEW_NEXT_STEPS as Record<string, string> | undefined)?.[next]}`;
      for (const key of ["first", "second"]) {
        unavailable(f);
        expect(await f.submit(key)).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      }
      const [a1, a2] = f.attempts();
      expect((await f.notices()).map((p) => [p["attemptId"], p["unjudgedAttempts"], p["unjudgedAttemptLimit"], p["nextStep"], p["recovery"]])).toEqual([
        [a1, 1, 2, "RESUBMIT", step("RESUBMIT")],
        [a2, 2, 2, "ESCALATE", step("ESCALATE")],
      ]);
      // A replay of the last submit is its stored answer: no third notice.
      await f.submit("second");
      expect(f.revisionRows()).toHaveLength(2);
    } finally { await f.close(); }
  });

  for (const kind of ["plain", "private"] as const) {
    it(`${kind} run: at the limit the pipeline refuses the same candidate again and again, verifying and reviewing nothing; a changed candidate goes through`, async () => {
      const f = await fixture(kind);
      try {
        for (const key of ["first", "second"]) {
          unavailable(f);
          expect(await f.submit(key)).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
        }
        const candidate = f.h.cp.runs.currentCandidate(f.run.runId);
        const work = () => ({ reviews: f.h.scripted.invocations.filter((call) => call.prompt.includes("Candidate review")).length,
          verifications: f.h.cp.artifacts.list(f.run.runId, "VERIFICATION").length,
          commands: f.h.cp.audit.forRun(f.run.runId).filter((row) => row.kind.startsWith("VERIFICATION")).length,
          outbox: f.h.cp.db.all<Args>("SELECT message_id FROM outbox WHERE run_id = ?", [f.run.runId]).length });
        const before = { work: work(), product: f.productState() };
        // Each counter is live: the two judged-unavailable submissions verified and reviewed.
        expect(before.work).toMatchObject({ reviews: 2, verifications: 2, outbox: 3 });
        expect(before.work.commands).toBeGreaterThan(0);
        unavailable(f);
        const refused = [await f.submit("third"), await f.submit("fourth")];
        for (const answer of refused) {
          expect(answer).toMatchObject({ ok: false, reasonCode: "REVIEW_UNJUDGED_LIMIT_REACHED" });
          if (kind === "private") {
            expect(answer).toMatchObject({ evidence: { privateReviewEvidence: true, reasonCode: "REVIEW_UNJUDGED_LIMIT_REACHED", candidateSnapshotDigest: candidate } });
            expect(JSON.stringify(answer)).not.toContain(MARKER);
          } else {
            expect(answer).toMatchObject({ message: pipeline.UNJUDGED_REVIEW_LIMIT_REFUSAL,
              evidence: { candidateSnapshotDigest: candidate, unjudgedAttempts: 2, unjudgedAttemptLimit: 2 } });
          }
        }
        // Nothing was verified, reviewed, sent or moved: no reviewer call, no verification, no notice, no product change.
        expect({ work: work(), product: f.productState() }).toEqual(before);
        expect(f.revisionRows()).toHaveLength(2);
        // A replay of a refused submit is its stored answer.
        expect(await f.submit("fourth")).toEqual(refused[1]);
        // A changed candidate is judged afresh, and starts its own count.
        writeFiles(f.h.repoPath, { "src/app.js": "module.exports = () => 1 + 1;\n" });
        commitAll(f.h.repoPath, "same result, new candidate");
        expect(await f.submit("changed")).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
        expect(f.h.cp.runs.currentCandidate(f.run.runId)).not.toBe(candidate);
        expect(work().reviews).toBe(before.work.reviews + 1);
        expect((await f.notices()).at(-1)).toMatchObject({ attemptId: f.attempts().at(-1), unjudgedAttempts: 1, nextStep: "RESUBMIT" });
      } finally { await f.close(); }
    });
  }

  it("a private run's method findings reach the owner's notice and the private review only: no answer, stored result, audit row or dogfood record", async () => {
    const f = await fixture("private");
    try {
      f.review({ verdict: "BLOCK", findings: [{ ...blocker(f.identity), category: "method", severity: "MAJOR", summary: `method: ${MARKER}` }] });
      const answer = await f.submit("submit-method");
      expect(answer).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: "REVIEW_REQUIRED" } });
      expect(JSON.stringify(answer)).not.toContain(MARKER);
      const tables = f.h.cp.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name);
      const holding = tables.filter((table) => JSON.stringify(f.h.cp.db.all<Args>(`SELECT * FROM "${table}"`)).includes(MARKER)).sort();
      expect(holding).toEqual(["outbox", "run_artifacts"]);
      expect(f.h.cp.db.all<{ kind: string }>("SELECT kind FROM outbox WHERE payload_json LIKE ?", [`%${MARKER}%`])).toEqual([{ kind: "REVISION_REQUEST" }]);
      expect(f.h.cp.db.all<{ kind: string }>("SELECT kind FROM run_artifacts WHERE content_json LIKE ?", [`%${MARKER}%`])).toEqual([{ kind: "BLIND_REVIEW" }]);
    } finally { await f.close(); }
  });

  it("role_dispatch_pending and the driven CTO's prompt tell a notice apart from a revision", async () => {
    const f = await fixture("plain");
    try {
      const server = createCtoServer(createCtoMcpPort(f.h.cp), () => allow(ReasonCode.OK, { actor: "f1", sessionId: f.owner.sessionId,
        sessionIncarnation: f.h.cp.sessions.require(f.owner.sessionId).incarnation }));
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "f1-tools", version: "1" });
      await client.connect(ct);
      try {
        const description = (await client.listTools()).tools.find((tool) => tool.name === "role_dispatch_pending")?.description ?? "";
        expect(description).toContain("A REVISION_REQUEST whose payload stage is review-unavailable is a notice, never a revision");
        expect(description).toContain("change no PLAN, task or code");
      } finally { await client.close(); await server.close(); }
    } finally { await f.close(); }

    const prompt = (driven as { workPrompt?: (...args: unknown[]) => string }).workPrompt;
    const line = (driven as { UNJUDGED_NOTICE_LINE?: string }).UNJUDGED_NOTICE_LINE;
    expect(typeof prompt).toBe("function");
    expect(line).toContain("never a revision");
    const binding = { role: "PRIMARY_CTO", runId: null, bindingGeneration: 1, roleKey: "primary-cto:fixture" } as unknown as RoleBinding;
    const triggers = [{ id: "msg_fixture", kind: "in-band dispatch" }];
    const withNotice = prompt!(binding, triggers, true, false, true);
    const without = prompt!(binding, triggers, true, false);
    expect(withNotice.split("\n")).toContain(line);
    expect(without).not.toContain("review-unavailable");
    expect(withNotice.split("\n").filter((l) => l !== line).join("\n")).toBe(without);
  });
});
