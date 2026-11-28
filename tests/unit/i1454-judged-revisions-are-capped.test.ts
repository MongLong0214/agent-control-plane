import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon, OPERATOR_METHOD } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL, defaultProcessAncestryInspector } from "../../src/registry/canonical-self-claim.ts";
import * as pipeline from "../../src/run/candidate-pipeline.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * #1454 — judged returns to the CTO (a verification failure, a review REVISE/BLOCK, a PASS carrying a blocker) are
 * counted per run by distinct candidate. The REVISION_LIMIT-th return asks for a re-plan, and no result is taken until
 * the PLAN changed; the REVISION_BUDGET-th return fails the run instead of returning it again.
 */
type Args = Record<string, unknown>;
const WORK_BRANCH = "feature/i1454-revisions";
const CONVERSATION = "14541454-1454-4454-8454-145414541454";
const START_TOKEN = "darwin-tv:1700000000.000000";

/** A STANDARD run owned by an adopted canonical CTO, planned through plan_submit, its one task done. */
async function fixture() {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h);
  h.cp.providers.register(new TestProductionAdapter(h.clock, "claude"));
  const startToken = vi.spyOn(defaultProcessAncestryInspector, "readStartToken").mockImplementation((pid) => (pid === process.pid ? START_TOKEN : null));
  const owner = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: START_TOKEN });
  expect(h.cp.sessions.transition(owner.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: owner.sessionId, mode: "PREFERRED",
    authenticatedTarget: { claimed, protocolVersion: SELF_CLAIM_PROTOCOL, attestationDigest: digestOf({ fixture: "i1454", sessionId: owner.sessionId }), verify: () => claimed } });
  if (!bound.allowed) throw new Error(bound.message);
  bindCeo(h);
  const contract = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
    acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [] };
  const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  expect(run.ownerSessionId).toBe(owner.sessionId);

  const closers: Array<{ close(): Promise<void> }> = [];
  const session = h.cp.sessions.require(owner.sessionId);
  const server = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: owner.sessionId, sessionId: owner.sessionId, sessionIncarnation: session.incarnation }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "i1454", version: "1" });
  await client.connect(ct);
  closers.push(server, client);
  const cto = async (name: string, args: Args): Promise<Args> => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
  };

  /** Runs `taskId` once to a SUCCEEDED receipt naming `commit`. */
  const execute = (taskId: string, commit: string) => {
    const execution = h.cp.tasks.startExecution({ runId: run.runId, taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: bindWorker(h, taskId), provider: "scripted", model: "scripted-worker", repositoryId });
    if (!execution.allowed) throw new Error(execution.message);
    h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${commit}` });
  };
  /** One PLAN through plan_submit, with one new task, which is then run to SUCCEEDED on a new commit. */
  const plan = async (summary: string, commit: () => string) => {
    const planned = await cto("plan_submit", { idempotencyKey: `plan-${summary}`, runId: run.runId, plan: { summary },
      tasks: [{ key: summary, title: summary, category: "implementation" }] });
    expect(planned, JSON.stringify(planned).slice(0, 600)).toMatchObject({ ok: true });
    const task = h.cp.tasks.ready(run.runId).find((ready) => ready.title === summary)!;
    execute(task.taskId, commit());
    return h.cp.artifacts.latest(run.runId, "PLAN")!.digest;
  };
  const firstPlan = await plan("first plan", () => applyPassingChange(h.repoPath, WORK_BRANCH));

  /** A new candidate: the same passing result, a different tree. */
  const change = (note: string) => {
    writeFiles(h.repoPath, { "src/app.js": `module.exports = () => 2; // ${note}\n` });
    return commitAll(h.repoPath, note);
  };
  /** A new candidate whose verification fails. */
  const breakIt = (note: string) => {
    writeFiles(h.repoPath, { "src/app.js": `module.exports = () => 3; // ${note}\n` });
    return commitAll(h.repoPath, note);
  };
  const finding = (note: string) => ({ category: "correctness", severity: "BLOCKER", repository: identity, path: "src/app.js",
    summary: `finding ${note}`, detail: `detail ${note}` });
  const scriptBlock = (note: string) => h.scripted.script({ match: /Candidate review/, text: JSON.stringify({
    verdict: "BLOCK", coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [finding(note)] }) });
  const scriptUnavailable = () => h.scripted.script({ match: /Candidate review/, text: "not a verdict" });
  const submit = (key: string) => cto("result_submit", { idempotencyKey: key, runId: run.runId, resultSummary: "app returns 2", recommendation: "merge" });
  /** A changed candidate, a BLOCK on it, and its submission, which must come back REVISION_REQUIRED. */
  const block = async (note: string): Promise<string> => {
    change(note);
    scriptBlock(note);
    const answer = await submit(note);
    expect(answer, JSON.stringify(answer).slice(0, 600)).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED", reasonCode: "REVIEW_BLOCK" } });
    return h.cp.runs.currentCandidate(run.runId)!;
  };
  /** The payload of every revision (not unjudged-review notice) the owner was sent, oldest first. */
  const revisions = (): Args[] => h.cp.db.all<{ payload_json: string }>(
    "SELECT payload_json FROM outbox WHERE run_id = ? AND kind = 'REVISION_REQUEST' ORDER BY rowid", [run.runId])
    .map((row) => JSON.parse(row.payload_json) as Args)
    .filter((payload) => payload["stage"] !== "review-unavailable");
  const returns = () => h.cp.audit.forRun(run.runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO");
  /** Everything a submission could do: review, verify, freeze, send, and the run row. */
  const footprint = () => ({
    reviews: h.scripted.invocations.filter((call) => call.prompt.includes("Candidate review")).length,
    verifications: h.cp.artifacts.list(run.runId, "VERIFICATION").length,
    frozen: h.cp.audit.forRun(run.runId).filter((row) => row.kind === "CANDIDATE_FROZEN").length,
    outbox: h.cp.outbox.listByRun(run.runId).length,
    returns: returns().length,
    run: h.cp.db.get<Args>("SELECT state, state_reason, revision_count, current_candidate_digest FROM runs WHERE run_id = ?", [run.runId]),
  });
  const show = async () => {
    const daemon = new Daemon(h.cp, { stateDir: tempDir("i1454-show-") });
    try {
      expect(daemon.lock.acquire(h.clock.nowIso()).allowed).toBe(true);
      return await daemon.handleOperatorRequest(
        { requestId: "show", method: OPERATOR_METHOD.RUN_SHOW, params: { runId: run.runId } },
        { actor: "operator", channel: "cli", peerId: "test", incarnation: "test" },
      );
    } finally {
      daemon.lock.release();
    }
  };
  return { h, run, firstPlan, cto, plan, change, breakIt, scriptBlock, scriptUnavailable, submit, block, revisions, returns, footprint, show,
    close: async () => { for (const c of closers.reverse()) await c.close(); h.cp.close(); startToken.mockRestore(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Three BLOCKs on three distinct candidates: the run is at REVISION_LIMIT. */
const toLimit = async (f: Fixture): Promise<string[]> => [await f.block("c1"), await f.block("c2"), await f.block("c3")];

describe("#1454 judged revisions are capped per run", () => {
  it("the third judged return asks for a re-plan, with the prior returns and their findings", async () => {
    const f = await fixture();
    try {
      const [c1, c2, c3] = await toLimit(f);
      const payloads = f.revisions();
      expect(payloads.map((p) => [p["judgedRevisions"], p["judgedRevisionLimit"], p["judgedRevisionBudget"], p["nextStep"] ?? null]))
        .toEqual([[1, 3, 6, null], [2, 3, 6, null], [3, 3, 6, "REPLAN"]]);
      expect(payloads[2]).toMatchObject({ candidateSnapshotDigest: c3, planDigestAtLimit: f.firstPlan, priorReturns: [
        { candidateSnapshotDigest: c1, stage: "blind-review", reasonCode: "REVIEW_BLOCK", findings: [{ severity: "BLOCKER", path: "src/app.js", summary: "finding c1" }] },
        { candidateSnapshotDigest: c2, stage: "blind-review", reasonCode: "REVIEW_BLOCK", findings: [{ severity: "BLOCKER", path: "src/app.js", summary: "finding c2" }] },
      ] });
      expect(payloads[0]).not.toHaveProperty("priorReturns");
      // The audit row keeps the counts and the PLAN at the limit, never the findings' text.
      const rows = f.returns();
      expect(rows.map((row) => row.evidence["judgedRevisions"])).toEqual([1, 2, 3]);
      expect(rows[2]!.evidence).toMatchObject({ judgedRevisionLimit: 3, judgedRevisionBudget: 6, nextStep: "REPLAN", planDigestAtLimit: f.firstPlan });
      expect(JSON.stringify(rows.map((row) => row.evidence))).not.toContain("finding c");
    } finally { await f.close(); }
  });

  it("at the limit result_submit is refused REVISION_LIMIT_REACHED, changing nothing, until plan_submit changes the PLAN", async () => {
    const f = await fixture();
    try {
      await toLimit(f);
      f.change("c4");
      f.scriptBlock("c4");
      const before = f.footprint();
      const refused = await f.submit("c4");
      expect(refused).toMatchObject({ ok: false, reasonCode: "REVISION_LIMIT_REACHED", message: pipeline.REVISION_LIMIT_REFUSAL,
        evidence: { planDigestAtLimit: f.firstPlan, judgedRevisions: 3, judgedRevisionLimit: 3 } });
      expect(pipeline.REVISION_LIMIT_REFUSAL).toContain("plan_submit");
      // Nothing was verified, reviewed, frozen or sent, and the run did not move.
      expect(f.footprint()).toEqual(before);
      expect(f.h.cp.audit.forRun(f.run.runId).filter((row) => row.kind === "REVISION_LIMIT_REFUSED")).toHaveLength(1);
      // The same PLAN again is no re-plan.
      expect(await f.submit("c4-again")).toMatchObject({ ok: false, reasonCode: "REVISION_LIMIT_REACHED" });
      // A changed PLAN clears it.
      await f.plan("second plan", () => f.change("c4-replanned"));
      f.scriptBlock("c4-replanned");
      expect(await f.submit("c4-replanned")).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
      expect(f.revisions().at(-1)).toMatchObject({ judgedRevisions: 4 });
      expect(f.revisions().at(-1)).not.toHaveProperty("nextStep");
    } finally { await f.close(); }
  });

  it("the sixth judged return sends no REVISION_REQUEST and fails the run REVISION_BUDGET_EXHAUSTED; nothing more is frozen", async () => {
    const f = await fixture();
    try {
      const candidates = await toLimit(f);
      await f.plan("second plan", () => f.change("replanned"));
      candidates.push(await f.block("c4"), await f.block("c5"));
      f.change("c6");
      f.scriptBlock("c6");
      const answer = await f.submit("c6");
      const c6 = f.h.cp.runs.currentCandidate(f.run.runId)!;
      candidates.push(c6);
      expect(answer).toMatchObject({ ok: false, reasonCode: "REVISION_BUDGET_EXHAUSTED",
        evidence: { judgedRevisions: 6, candidateSnapshotDigests: candidates } });
      expect(f.revisions()).toHaveLength(5);
      expect(f.returns()).toHaveLength(6);
      expect(f.footprint().run).toMatchObject({ state: "FAILED" });
      const failed = f.h.cp.audit.forRun(f.run.runId).filter((row) => row.kind === "RUN_TRANSITION" && row.evidence["to"] === "FAILED");
      expect(failed).toMatchObject([{ evidence: { from: "ACTIVE", reasonCode: "REVISION_BUDGET_EXHAUSTED", judgedRevisions: 6, candidateSnapshotDigests: candidates } }]);
      // No seventh candidate is frozen.
      const frozen = f.footprint().frozen;
      f.change("c7");
      f.scriptBlock("c7");
      expect(await f.submit("c7")).toMatchObject({ ok: false });
      expect(f.footprint().frozen).toBe(frozen);
      expect(f.revisions()).toHaveLength(5);
    } finally { await f.close(); }
  });

  it("a verification FAIL counts, an unjudged review does not, a candidate returned twice counts once; run show reports it", async () => {
    const f = await fixture();
    try {
      f.breakIt("v1");
      expect(await f.submit("v1")).toMatchObject({ ok: true, value: { stage: "VERIFICATION_FAILED" } });
      expect(await f.submit("v1-again")).toMatchObject({ ok: true, value: { stage: "VERIFICATION_FAILED" } });
      f.change("u1");
      f.scriptUnavailable();
      expect(await f.submit("u1")).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      await f.block("b1");
      expect(f.revisions().map((p) => [p["stage"], p["judgedRevisions"]])).toEqual([["verification", 1], ["verification", 1], ["blind-review", 2]]);
      const shown = await f.show();
      expect(shown).toMatchObject({ allowed: true, value: { revisions: { judged: 2, limit: 3, budget: 6 } } });
    } finally { await f.close(); }
  });
});
