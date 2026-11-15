import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { applyFailingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1402 — a run with CEO-attached private review evidence is answered with its projection (`privateEvidenceAnswer`):
 * stage VERIFICATION_FAILED and verification counts, no `report`. result_submit answered that applied outcome with
 * INTERNAL_ERROR "Cannot read properties of undefined (reading 'results')" because it stripped the captured output of
 * a report the answer does not carry.
 */
type Args = Record<string, unknown>;
const CONTRACT = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
  acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [] };
const SOURCE = "a synthetic private source the excerpt is cut from";
const bundleFor = (runId: string, contractDigest: string) => {
  const bytes = Buffer.from("## result\nSYNTHETIC-PRIVATE-EXCERPT-1402\n", "utf8");
  return JSON.stringify({ runId, contractDigest, missing: ["the rest of the source"], files: [{
    path: "handoff/excerpt.md", sha256: sha256(bytes), origin: "private handoff, synthetic", grade: "review-original",
    bodyBase64: bytes.toString("base64"), excerpt: { originalSha256: sha256(SOURCE), omitted: true, ranges: [
      { section: "failure", startLine: 4, endLine: 4 }, { section: "fix", startLine: 9, endLine: 9 }, { section: "result", startLine: 12, endLine: 12 }] },
  }] });
};

async function failingRun() {
  const h = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(h, "fixture-project");
  const ceo = bindCeo(h);
  const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  const task = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({ runId: run.runId, taskId: task.taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, task.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyFailingChange(h.repoPath);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });

  const lineage = digestOf("i1402 lineage");
  const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId, lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const closers: Array<{ close(): Promise<void> }> = [];
  const connect = async (kind: "cto" | "hermes", sessionId: string) => {
    const session = h.cp.sessions.require(sessionId);
    const auth = () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: session.incarnation });
    const server = kind === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth) : createHermesServer(createHermesMcpPort(h.cp), auth, { provenance: anchor });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "i1402", version: "1" });
    await client.connect(ct);
    closers.push(server, client);
    return async (name: string, args: Args): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: meta }, undefined, { timeout: 120_000 });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
  };
  const cto = await connect("cto", run.ownerSessionId!);
  const hermes = await connect("hermes", ceo);
  const attachPrivateEvidence = async () => {
    const evidenceBody = bundleFor(run.runId, run.contractDigest);
    expect(await cto("review_evidence_stage", { idempotencyKey: "stage", runId: run.runId, contractDigest: run.contractDigest, evidenceBody,
      expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: true });
    expect(await hermes("review_evidence_attach", { idempotencyKey: "attach", runId: run.runId, contractDigest: run.contractDigest,
      stagedBy: run.ownerRoleKey!, expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: true });
  };
  const submit = (idempotencyKey: string) => cto("result_submit", { idempotencyKey, runId: run.runId, resultSummary: "app returns 2", recommendation: "merge" });
  const count = (kind: string) => h.cp.audit.forRun(run.runId).filter(e => e.kind === kind).length;
  const ended = () => h.cp.audit.forRun(run.runId).filter(e => e.kind === "CANDIDATE_PIPELINE_ATTEMPT_ENDED").map(e => e.evidence);
  return { h, run, submit, attachPrivateEvidence, count, ended,
    close: async () => { for (const c of closers.reverse()) await c.close(); h.cp.close(); } };
}

describe("#1402 result_submit answers an applied VERIFICATION_FAILED", () => {
  it("a private-evidence run's applied VERIFICATION_FAILED answers its stage and reason code, not INTERNAL_ERROR, and a replay runs nothing again", async () => {
    const f = await failingRun();
    try {
      await f.attachPrivateEvidence();
      const pipeline = vi.spyOn(f.h.cp.pipeline, "submitResult");
      const answer = await f.submit("submit-1402");
      expect(JSON.stringify(answer)).not.toContain("Cannot read properties");
      expect(answer).toMatchObject({ ok: true, reasonCode: "OK", value: {
        privateReviewEvidence: true, outcome: "NOT_COMPLETED", stage: "VERIFICATION_FAILED", reasonCode: "VERIFICATION_COMMAND_FAILED",
        verification: { status: "FAIL" },
      } });
      expect(f.ended()).toEqual([expect.objectContaining({ outcome: "APPLIED", stage: "VERIFICATION_FAILED" })]);
      expect(f.count("REVISION_RETURNED_TO_CTO")).toBe(1);

      // The same key replays the stored answer: no second attempt, freeze or verification.
      const frozen = f.count("CANDIDATE_FROZEN");
      const verified = f.count("VERIFICATION_COMPLETED");
      expect(await f.submit("submit-1402")).toEqual(answer);
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect([f.count("CANDIDATE_FROZEN"), f.count("VERIFICATION_COMPLETED"), f.ended().length]).toEqual([frozen, verified, 1]);
    } finally { await f.close(); }
  });

  it("a run without private evidence still answers VERIFICATION_FAILED with its report's excerpts and no captured output", async () => {
    const f = await failingRun();
    try {
      const pipeline = vi.spyOn(f.h.cp.pipeline, "submitResult");
      const answer = await f.submit("submit-plain");
      // The pipeline's own answer carries the whole capture; the tool answer must not.
      const outcome = await pipeline.mock.results[0]!.value as { value: { report: { results: Args[] } } };
      expect(outcome.value.report.results.some(result => "capturedOutput" in result)).toBe(true);
      expect(answer).toMatchObject({ ok: true, value: { stage: "VERIFICATION_FAILED", reasonCode: "VERIFICATION_COMMAND_FAILED", report: { status: "FAIL" } } });
      const results = ((answer["value"] as Args)["report"] as { results: Args[] }).results;
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) expect(result).not.toHaveProperty("capturedOutput");
    } finally { await f.close(); }
  });
});
