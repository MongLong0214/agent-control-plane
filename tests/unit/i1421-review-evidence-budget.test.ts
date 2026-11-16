import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import type * as BudgetModule from "../../src/review/review-prompt-budget.ts";

import { allow } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL, defaultProcessAncestryInspector } from "../../src/registry/canonical-self-claim.ts";
import { frontierReviewPolicy } from "../../src/review/frontier-simplify-policy.ts";
import {
  REVIEW_PROMPT_BUDGET_PROBLEM, REVIEW_PROMPT_OTHER_ALLOWANCE_CHARS, reviewEvidenceLimitChars,
} from "../../src/review/review-prompt-budget.ts";
import { privateEvidenceAnswer } from "../../src/review/standard-review-evidence.ts";
import * as pipeline from "../../src/run/candidate-pipeline.ts";
import { REVIEWER_TRANSPORT_SEPARATOR } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

// A bundle staged before the stage and attach refused it is the live case; `bypass` stands in for that time.
const bypass = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/review/review-prompt-budget.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof BudgetModule>();
  return { ...actual, reviewEvidenceLimitChars: () => (bypass.on ? Number.MAX_SAFE_INTEGER : actual.reviewEvidenceLimitChars()) };
});

afterAll(cleanupTempDirs);

/** #1421 — private review evidence too large for the reviewer prompt: refused up front, visible when it is not, and never an unjudged attempt. */
type Args = Record<string, unknown>;
const MARKER = "SYNTHETIC-I1421-PRIVATE-EXCERPT-5d2a";
const WORK_BRANCH = "feature/I1421-budget";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const START_TOKEN = "darwin-tv:1700000000.000000";

/** A bundle of `count` files of `bytes` bytes each; every file is a whole-line excerpt of a larger synthetic source. */
const bundleOf = (runId: string, contractDigest: string, count: number, bytes: number): string => {
  const line = "synthetic excerpt line with ordinary words only\n";
  const files = Array.from({ length: count }, (_, i) => {
    const body = (`## result ${i}\n` + line.repeat(Math.ceil(bytes / line.length))).slice(0, bytes - 1) + "\n";
    const buffer = Buffer.from(body, "utf8");
    const lines = body.split("\n").length - 1;
    return { path: `handoff/excerpt-${i}.md`, sha256: sha256(buffer), origin: "private handoff, synthetic", grade: "review-original",
      bodyBase64: buffer.toString("base64"),
      excerpt: { originalSha256: sha256(`${MARKER} source ${i}`), omitted: true, ranges: [{ section: "excerpt", startLine: 1, endLine: lines }] } };
  });
  return JSON.stringify({ runId, contractDigest, missing: ["the rest of the sources"], files });
};

async function fixture(kind: "private" | "plain") {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h);
  h.cp.providers.register(new TestProductionAdapter(h.clock, "claude"));
  const startToken = vi.spyOn(defaultProcessAncestryInspector, "readStartToken").mockImplementation((pid) => (pid === process.pid ? START_TOKEN : null));
  const owner = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: START_TOKEN });
  expect(h.cp.sessions.transition(owner.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: owner.sessionId, mode: "PREFERRED",
    authenticatedTarget: { claimed, protocolVersion: SELF_CLAIM_PROTOCOL, attestationDigest: digestOf({ fixture: "i1421", sessionId: owner.sessionId }), verify: () => claimed } });
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
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({ runId: run.runId, taskId: impl.taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, impl.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${applyPassingChange(h.repoPath, WORK_BRANCH)}` });

  const lineage = digestOf("i1421 lineage");
  const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId, lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const closers: Array<{ close(): Promise<void> }> = [];
  async function connect(as: "cto" | "hermes", sessionId: string) {
    const session = h.cp.sessions.require(sessionId);
    const auth = () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation });
    const server = as === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth) : createHermesServer(createHermesMcpPort(h.cp), auth, { provenance: anchor });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "i1421-budget", version: "1" });
    await client.connect(ct);
    closers.push(server, client);
    return async (name: string, args: Args): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: meta }, undefined, { timeout: 120_000 });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
  }
  const cto = await connect("cto", owner.sessionId);
  const hermes = await connect("hermes", ceo);
  const stage = (key: string, body: string) => cto("review_evidence_stage", { idempotencyKey: key, runId: run.runId, contractDigest: run.contractDigest,
    evidenceBody: body, expectedSha256: sha256(body) });
  const attach = (key: string, body: string) => hermes("review_evidence_attach", { idempotencyKey: key, runId: run.runId, contractDigest: run.contractDigest,
    stagedBy: run.ownerRoleKey!, expectedSha256: sha256(body) });
  const bundle = (count: number, bytes: number) => bundleOf(run.runId, run.contractDigest, count, bytes);
  const submit = (key: string) => cto("result_submit", { idempotencyKey: key, runId: run.runId, resultSummary: "app returns 2", recommendation: "merge" });
  const notices = async (): Promise<Args[]> => {
    const body = await cto("role_dispatch_pending", {});
    return ((body["value"] as { messages: Array<Args & { kind: string; payload: Args }> }).messages)
      .filter((message) => message.kind === "REVISION_REQUEST").map((message) => message.payload);
  };
  const unavailableRows = () => h.cp.audit.forRun(run.runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE");
  const review = () => h.scripted.script({ match: /Candidate review/, text: JSON.stringify({
    verdict: "PASS", coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [] }) });
  void kind;
  return { h, run, identity, stage, attach, bundle, submit, notices, unavailableRows, review,
    close: async () => { for (const c of closers.reverse()) await c.close(); h.cp.close(); startToken.mockRestore(); } };
}

describe("#1421 (1) stage and attach refuse evidence whose rendered text leaves no chunk room", () => {
  it("the stage refuses it with its own reason code, the measured size and the limit, and stores nothing", async () => {
    const f = await fixture("private");
    try {
      const limit = reviewEvidenceLimitChars();
      const body = f.bundle(7, 15_000);
      const refused = await f.stage("stage-big", body);
      expect(refused).toMatchObject({ ok: false, reasonCode: "REVIEW_EVIDENCE_OVER_BUDGET", evidence: { problem: REVIEW_PROMPT_BUDGET_PROBLEM, limit } });
      const rendered = (refused["evidence"] as { rendered: number }).rendered;
      expect(rendered).toBeGreaterThan(limit);
      expect(String(refused["message"])).toContain(String(rendered));
      expect(String(refused["message"])).toContain(String(limit));
      expect(JSON.stringify(refused)).not.toContain(MARKER);
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toEqual([]);
      // A bundle with room is staged and attached as before.
      const small = f.bundle(2, 15_000);
      expect(await f.stage("stage-small", small)).toMatchObject({ ok: true });
      expect(await f.attach("attach-small", small)).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("the attach refuses a bundle staged before the stage refused it, with the same code and counts", async () => {
    const f = await fixture("private");
    try {
      const body = f.bundle(7, 15_000);
      bypass.on = true;
      expect(await f.stage("stage-old", body)).toMatchObject({ ok: true });
      bypass.on = false;
      const refused = await f.attach("attach-big", body);
      expect(refused).toMatchObject({ ok: false, reasonCode: "REVIEW_EVIDENCE_OVER_BUDGET", evidence: { problem: REVIEW_PROMPT_BUDGET_PROBLEM, limit: reviewEvidenceLimitChars() } });
      expect((refused["evidence"] as { rendered: number }).rendered).toBeGreaterThan(reviewEvidenceLimitChars());
      expect(f.h.cp.audit.forRun(f.run.runId).filter((row) => row.kind === "STANDARD_REVIEW_EVIDENCE_ATTACHED")).toEqual([]);
    } finally { bypass.on = false; await f.close(); }
  });

  it("the allowance covers what a real review of a plain run sends besides the method and the diff", async () => {
    const f = await fixture("plain");
    try {
      f.review();
      expect(await f.submit("plain")).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      const call = f.h.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Candidate review"))!;
      const sent = call.prompt.length + (call.systemPrompt?.length ?? 0) + REVIEWER_TRANSPORT_SEPARATOR.length;
      // The prompt holds no private evidence and a one-line diff; the rest is the method plus what the allowance stands for.
      expect(sent - frontierReviewPolicy().length).toBeLessThan(REVIEW_PROMPT_OTHER_ALLOWANCE_CHARS);
      expect(sent - frontierReviewPolicy().length).toBeGreaterThan(REVIEW_PROMPT_OTHER_ALLOWANCE_CHARS / 4);
    } finally { await f.close(); }
  });
});

describe("#1421 (2)(3) an over-budget review is visible, counts, and is no unjudged attempt", () => {
  it("records overhead, budget and the marker; the owner is told it is deterministic; it never reaches the unjudged limit", async () => {
    const f = await fixture("private");
    try {
      const body = f.bundle(7, 15_000);
      bypass.on = true;
      expect(await f.stage("stage-old", body)).toMatchObject({ ok: true });
      expect(await f.attach("attach-old", body)).toMatchObject({ ok: true });
      bypass.on = false;

      const first = await f.submit("first");
      expect(first).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: "EVIDENCE_MISSING" } });
      // The answer a private-evidence run gets keeps counts and fixed enums only, and now says why.
      const budget = (first["value"] as { promptBudget?: { overhead: number; budget: number } }).promptBudget;
      expect(budget).toMatchObject({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, budget: 120_000, deterministic: true });
      expect(budget!.overhead).toBeGreaterThan(budget!.budget - 4_096);
      expect(JSON.stringify(first)).not.toContain(MARKER);

      const [row] = f.unavailableRows();
      expect(row!.evidence).toMatchObject({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: budget!.overhead, budget: 120_000 });

      const [notice] = await f.notices();
      expect(notice).toMatchObject({ notice: "REVIEW_PROMPT_BUDGET_EXCEEDED", nextStep: "DETERMINISTIC", unjudgedAttempts: 0, unjudgedAttemptLimit: 2,
        recovery: `${pipeline.UNJUDGED_REVIEW_NOTICES.REVIEW_PROMPT_BUDGET_EXCEEDED} ${pipeline.UNJUDGED_REVIEW_NEXT_STEPS.DETERMINISTIC}` });

      // Not an unjudged attempt: further submissions are judged again, not refused at the limit.
      for (const key of ["second", "third", "fourth"]) {
        expect(await f.submit(key)).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: "EVIDENCE_MISSING" } });
      }
      expect(f.unavailableRows()).toHaveLength(4);
      expect(f.h.scripted.invocations.filter((call) => call.prompt.includes("Candidate review"))).toEqual([]);
    } finally { bypass.on = false; await f.close(); }
  });

  it("an unavailable review that is not deterministic still counts and still ends at the limit", async () => {
    const f = await fixture("plain");
    try {
      for (const key of ["first", "second"]) {
        f.h.scripted.script({ match: /Candidate review/, text: `not a verdict: ${MARKER}` });
        expect(await f.submit(key)).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      }
      expect((await f.notices()).map((p) => [p["unjudgedAttempts"], p["nextStep"]])).toEqual([[1, "RESUBMIT"], [2, "ESCALATE"]]);
      expect(await f.submit("third")).toMatchObject({ ok: false, reasonCode: "REVIEW_UNJUDGED_LIMIT_REACHED" });
    } finally { await f.close(); }
  });

  it("privateEvidenceAnswer carries the two counts and the fixed marker only when they are whole numbers and the marker is exact", async () => {
    const f = await fixture("plain");
    try {
      const source = { artifacts: f.h.cp.artifacts, audit: f.h.cp.audit };
      const answer = (evidence: Args) => privateEvidenceAnswer(source, f.run.runId,
        allow(ReasonCode.OK, { stage: "REVIEW_UNAVAILABLE", reasonCode: "EVIDENCE_MISSING", detail: { message: MARKER, evidence } }) as never);
      const kept = answer({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 142_367, budget: 120_000, note: MARKER });
      expect(kept).toMatchObject({ allowed: true, value: { promptBudget: { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 142_367, budget: 120_000, deterministic: true } } });
      expect(JSON.stringify(kept)).not.toContain(MARKER);
      for (const evidence of [{ problem: "OTHER", overhead: 1, budget: 2 }, { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: MARKER, budget: 2 },
        { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 1.5, budget: 2 }, { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: -1, budget: 2 }]) {
        expect(JSON.stringify(answer(evidence))).not.toContain("promptBudget");
      }
    } finally { await f.close(); }
  });
});
