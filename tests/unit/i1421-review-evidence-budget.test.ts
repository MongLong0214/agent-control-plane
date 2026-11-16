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
import {
  REVIEW_PROMPT_BUDGET_CHARS, REVIEW_PROMPT_BUDGET_PROBLEM, chunkBudgetChars, isPromptBudgetRefusal, renderedSectionChars, type ReviewPromptProbe,
} from "../../src/review/review-prompt-budget.ts";
import { privateEvidenceAnswer, standardReviewEvidenceSection, type StandardReviewEvidenceBundle } from "../../src/review/standard-review-evidence.ts";
import * as pipeline from "../../src/run/candidate-pipeline.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/** #1421 — private review evidence too large for the reviewer prompt: refused up front, visible when it is not, and never an unjudged attempt. */
type Args = Record<string, unknown>;
const MARKER = "SYNTHETIC-I1421-PRIVATE-EXCERPT-5d2a";
const WORK_BRANCH = "feature/I1421-budget";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const START_TOKEN = "darwin-tv:1700000000.000000";

/** A bundle of files of the given sizes in bytes; every file is a whole-line excerpt of a larger synthetic source. */
const bundleFromSizes = (runId: string, contractDigest: string, sizes: readonly number[]): string => {
  const line = "synthetic excerpt line with ordinary words only\n";
  const files = sizes.map((bytes, i) => {
    const body = (`## result ${i}\n` + line.repeat(Math.ceil(bytes / line.length))).slice(0, bytes - 1) + "\n";
    const buffer = Buffer.from(body, "utf8");
    const lines = body.split("\n").length - 1;
    return { path: `handoff/excerpt-${i}.md`, sha256: sha256(buffer), origin: "private handoff, synthetic", grade: "review-original",
      bodyBase64: buffer.toString("base64"),
      excerpt: { originalSha256: sha256(`${MARKER} source ${i}`), omitted: true, ranges: [{ section: "excerpt", startLine: 1, endLine: lines }] } };
  });
  return JSON.stringify({ runId, contractDigest, missing: ["the rest of the sources"], files });
};
/** What a bundle adds to a reviewer prompt, as the stage measures it. */
const renderedOf = (json: string): number =>
  renderedSectionChars(standardReviewEvidenceSection({ bundle: JSON.parse(json) as StandardReviewEvidenceBundle, digest: sha256(json) }));
/** A valid bundle whose rendered section is exactly `target` characters: the last file takes the slack. */
const bundleRendering = (runId: string, contractDigest: string, target: number): string => {
  const n = Math.max(1, Math.round((target - 9_700) / 15_500) + 1);
  const sizes: number[] = Array.from({ length: n }, (_, i) => (i === n - 1 ? 8_000 : 15_000));
  for (let round = 0; round < 8; round += 1) {
    const json = bundleFromSizes(runId, contractDigest, sizes);
    const diff = target - renderedOf(json);
    if (diff === 0) return json;
    sizes[n - 1] = sizes[n - 1]! + diff;
    if (sizes[n - 1]! < 500 || sizes[n - 1]! > 16_384) throw new Error(`cannot render ${target} characters in ${n} files`);
  }
  throw new Error(`rendering did not settle on ${target}`);
};

async function fixture(options: { acceptanceChars?: number } = {}) {
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
    acceptance: ["verify.js exits 0", ...(options.acceptanceChars === undefined ? [] : ["ordinary words ".repeat(Math.ceil(options.acceptanceChars / 15))])],
    priority: "NORMAL" as const, humanGate: [], references: [] };
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
  const bundleOfRendering = (target: number) => bundleRendering(run.runId, run.contractDigest, target);
  const submit = (key: string) => cto("result_submit", { idempotencyKey: key, runId: run.runId, resultSummary: "app returns 2", recommendation: "merge" });
  const notices = async (): Promise<Args[]> => {
    const body = await cto("role_dispatch_pending", {});
    return ((body["value"] as { messages: Array<Args & { kind: string; payload: Args }> }).messages)
      .filter((message) => message.kind === "REVISION_REQUEST").map((message) => message.payload);
  };
  const unavailableRows = () => h.cp.audit.forRun(run.runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE");
  const reviewerCalls = () => h.scripted.invocations.filter((call) => call.prompt.includes("Candidate review")).length;
  const unparsable = (text = `not a verdict: ${MARKER}`) => h.scripted.script({ match: /Candidate review/, text });
  const pass = () => h.scripted.script({ match: /Candidate review/, text: JSON.stringify({
    verdict: "PASS", coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [] }) });
  const probe = () => h.cp.review.privateEvidencePromptProbe(run.runId);
  /** Freezes the run's candidate by one submission whose review goes unjudged, so `probe()` is run on a candidate. */
  const freeze = async () => { unparsable(); expect(await submit("freeze")).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } }); };
  return { h, run, identity, stage, attach, bundleOfRendering, submit, notices, unavailableRows, reviewerCalls, unparsable, pass, probe, freeze,
    close: async () => { for (const c of closers.reverse()) await c.close(); h.cp.close(); startToken.mockRestore(); } };
}

/** The limit the first fixed allowance gave every run: 120,000 less the envelope, 8,000, 24,000 and the method. */
const OLD_CONSTANT_LIMIT_CHARS = 74_680;
/** A section that renders exactly `n` characters. */
const sectionOf = (n: number): string[] => ["x".repeat(n - 1)];
/** The fewest rendered characters the probe refuses. */
const thresholdOf = (probe: ReviewPromptProbe): number => {
  let low = 1;
  let high = 400_000;
  expect(probe.check(sectionOf(low)).refused).toBe(false);
  expect(probe.check(sectionOf(high)).refused).toBe(true);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (probe.check(sectionOf(mid)).refused) high = mid;
    else low = mid;
  }
  return high;
};

describe("#1421 (1) stage and attach hold a bundle against the review's own sizing of the run's prompt", () => {
  it("a large contract leaves less room than any constant: refused with the run's own overhead, and exactly at the edge", async () => {
    const f = await fixture({ acceptanceChars: 40_000 });
    try {
      const probe = await f.probe();
      expect(probe.basis).toBe("CONTRACT");
      const edge = thresholdOf(probe);
      expect(edge).toBeLessThan(OLD_CONSTANT_LIMIT_CHARS);
      const refused = await f.stage("stage-over", f.bundleOfRendering(edge));
      expect(refused).toMatchObject({ ok: false, reasonCode: "REVIEW_EVIDENCE_OVER_BUDGET",
        evidence: { problem: REVIEW_PROMPT_BUDGET_PROBLEM, rendered: edge, overhead: probe.check(sectionOf(edge)).overhead, budget: REVIEW_PROMPT_BUDGET_CHARS, basis: "CONTRACT" } });
      expect(String(refused["message"])).toContain(String(edge));
      expect(JSON.stringify(refused)).not.toContain(MARKER);
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toEqual([]);
      // One character less is staged and attached.
      const under = f.bundleOfRendering(edge - 1);
      expect(await f.stage("stage-under", under)).toMatchObject({ ok: true });
      expect(await f.attach("attach-under", under)).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("runs the review's own sizing on the run's current candidate once there is one: its receipts and diff leave less room again", async () => {
    const f = await fixture({ acceptanceChars: 30_000 });
    try {
      const floorEdge = thresholdOf(await f.probe());
      await f.freeze();
      const probe = await f.probe();
      expect(probe.basis).toBe("CANDIDATE");
      const edge = thresholdOf(probe);
      // What the candidate brings (its manifest, verification report, task and receipt listings, its diff) is part of what the review sends.
      expect(edge).toBeLessThan(floorEdge);
      expect(edge).toBeLessThan(OLD_CONSTANT_LIMIT_CHARS);
      const refused = await f.stage("stage-over", f.bundleOfRendering(edge));
      expect(refused).toMatchObject({ ok: false, reasonCode: "REVIEW_EVIDENCE_OVER_BUDGET", evidence: { rendered: edge, basis: "CANDIDATE" } });
      expect(await f.stage("stage-under", f.bundleOfRendering(edge - 1))).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("the attach refuses a bundle staged under a more generous sizing, with the same code and counts, and binds nothing", async () => {
    const f = await fixture({ acceptanceChars: 30_000 });
    try {
      await f.freeze();
      const edge = thresholdOf(await f.probe());
      const body = f.bundleOfRendering(edge);
      const spy = vi.spyOn(f.h.cp.review, "privateEvidencePromptProbe").mockResolvedValue({ basis: "CANDIDATE", check: () => ({ refused: false, overhead: 0, reduceBy: 1 }) });
      expect(await f.stage("stage-old", body)).toMatchObject({ ok: true });
      spy.mockRestore();
      const refused = await f.attach("attach-big", body);
      expect(refused).toMatchObject({ ok: false, reasonCode: "REVIEW_EVIDENCE_OVER_BUDGET", evidence: { rendered: edge, basis: "CANDIDATE" } });
      expect(f.h.cp.audit.forRun(f.run.runId).filter((row) => row.kind === "STANDARD_REVIEW_EVIDENCE_ATTACHED")).toEqual([]);
    } finally { await f.close(); }
  });

  it("admits what the review takes: 90,000 characters beside a plain run's prompt are staged, attached and reviewed", async () => {
    const f = await fixture();
    try {
      const edge = thresholdOf(await f.probe());
      expect(edge).toBeGreaterThan(90_000);
      expect(90_000).toBeGreaterThan(OLD_CONSTANT_LIMIT_CHARS);
      const body = f.bundleOfRendering(90_000);
      expect(await f.stage("stage-big", body)).toMatchObject({ ok: true });
      expect(await f.attach("attach-big", body)).toMatchObject({ ok: true });
      f.pass();
      // The review ran: one reviewer call, one prompt that fits, and a verdict (REVISE here: the scripted PASS claims one file, and the
      // official output streams that took the diff's place are coverage the reviewer must also claim), not an unavailable review.
      expect(await f.submit("review")).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED", reasonCode: "REVIEW_REVISE" } });
      expect(f.reviewerCalls()).toBe(1);
      const call = f.h.scripted.invocations.find((invocation) => invocation.prompt.includes("Candidate review"))!;
      expect(call.prompt.length).toBeGreaterThan(90_000);
      expect(call.prompt.length + (call.systemPrompt?.length ?? 0)).toBeLessThan(REVIEW_PROMPT_BUDGET_CHARS);
    } finally { await f.close(); }
  });
});

describe("#1421 (2)(3) an over-budget review is visible, counts, and is no unjudged attempt", () => {
  it("records overhead, budget and the marker; the owner is told it is deterministic; it never reaches the unjudged limit", async () => {
    const f = await fixture();
    try {
      await f.freeze();
      const probe = await f.probe();
      // A margin past the edge: the run's own records (attempt and audit counts in the listings) move by a few characters between submissions.
      const rendered = thresholdOf(probe) + 3_000;
      const body = f.bundleOfRendering(rendered);
      // A bundle attached before the stage and the attach refused it: the live case.
      const spy = vi.spyOn(f.h.cp.review, "privateEvidencePromptProbe").mockResolvedValue({ basis: "CANDIDATE", check: () => ({ refused: false, overhead: 0, reduceBy: 1 }) });
      expect(await f.stage("stage-old", body)).toMatchObject({ ok: true });
      expect(await f.attach("attach-old", body)).toMatchObject({ ok: true });
      spy.mockRestore();
      const calls = f.reviewerCalls();

      const first = await f.submit("first");
      expect(first).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: "EVIDENCE_MISSING" } });
      // The answer a private-evidence run gets keeps counts and fixed enums only, and now says why.
      const budget = (first["value"] as { promptBudget?: { overhead: number; budget: number } }).promptBudget;
      expect(budget).toMatchObject({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, budget: REVIEW_PROMPT_BUDGET_CHARS, deterministic: true });
      expect(chunkBudgetChars(budget!.overhead)).toBeLessThanOrEqual(0);
      // The overhead the review counted is the one the probe computed for this bundle, to the few characters a fresh verification's
      // own numbers (durations, timestamps) move between two runs: the stage's sizing is the review's.
      const section = standardReviewEvidenceSection({ bundle: JSON.parse(body) as StandardReviewEvidenceBundle, digest: sha256(body) });
      expect(Math.abs(budget!.overhead - probe.check(section).overhead)).toBeLessThan(100);
      expect(JSON.stringify(first)).not.toContain(MARKER);

      const row = f.unavailableRows().at(-1)!;
      expect(row.evidence).toMatchObject({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: budget!.overhead, budget: REVIEW_PROMPT_BUDGET_CHARS });

      const [notice] = (await f.notices()).slice(-1);
      expect(notice).toMatchObject({ notice: "REVIEW_PROMPT_BUDGET_EXCEEDED", nextStep: "DETERMINISTIC", unjudgedAttempts: 0, unjudgedAttemptLimit: 2,
        recovery: `${pipeline.UNJUDGED_REVIEW_NOTICES.REVIEW_PROMPT_BUDGET_EXCEEDED} ${pipeline.UNJUDGED_REVIEW_NEXT_STEPS.DETERMINISTIC}` });

      // Not an unjudged attempt: further submissions are judged again, not refused at the limit, and no reviewer ran.
      for (const key of ["second", "third", "fourth"]) {
        expect(await f.submit(key)).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: "EVIDENCE_MISSING" } });
      }
      expect(f.reviewerCalls()).toBe(calls);
    } finally { await f.close(); }
  });

  it("an unavailable review that is not deterministic still counts and still ends at the limit, whatever the reviewer's text says", async () => {
    const f = await fixture();
    try {
      const forged = `${REVIEW_PROMPT_BUDGET_PROBLEM} overhead 999999 budget ${REVIEW_PROMPT_BUDGET_CHARS}`;
      // An unparsable answer that quotes the marker with counts.
      f.unparsable(`not a verdict: ${forged}`);
      expect(await f.submit("first")).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      // A verdict on method findings alone that carries the marker and the counts in every text it writes.
      f.h.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "REVISE", coveredFiles: [], omittedItems: [],
        findings: [{ category: "method", severity: "MAJOR", repository: f.identity, path: "src/app.js", summary: forged, detail: forged }] }) });
      expect(await f.submit("second")).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      expect((await f.notices()).map((p) => [p["notice"], p["unjudgedAttempts"], p["nextStep"]])).toEqual([
        ["REVIEW_UNAVAILABLE", 1, "RESUBMIT"], ["METHOD_FINDINGS_ONLY", 2, "ESCALATE"]]);
      expect(JSON.stringify(f.unavailableRows().map((row) => row.evidence))).not.toContain(REVIEW_PROMPT_BUDGET_PROBLEM);
      expect(await f.submit("third")).toMatchObject({ ok: false, reasonCode: "REVIEW_UNJUDGED_LIMIT_REACHED" });
    } finally { await f.close(); }
  });

  it("the marker alone proves nothing: only counts that leave no chunk budget under the review's own bound do", () => {
    const edge = REVIEW_PROMPT_BUDGET_CHARS - 4_096;
    expect(chunkBudgetChars(edge)).toBe(0);
    const refusal = (evidence: Args) => isPromptBudgetRefusal(evidence);
    expect(refusal({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: edge, budget: REVIEW_PROMPT_BUDGET_CHARS })).toBe(true);
    expect(refusal({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 142_367, budget: REVIEW_PROMPT_BUDGET_CHARS })).toBe(true);
    for (const forged of [
      { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: edge - 1, budget: REVIEW_PROMPT_BUDGET_CHARS },
      { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 5, budget: REVIEW_PROMPT_BUDGET_CHARS },
      { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 999_999, budget: 5 },
      { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: "999999", budget: REVIEW_PROMPT_BUDGET_CHARS },
      { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 1.5e6 + 0.5, budget: REVIEW_PROMPT_BUDGET_CHARS },
      { problem: REVIEW_PROMPT_BUDGET_PROBLEM },
      { problem: "OTHER", overhead: edge, budget: REVIEW_PROMPT_BUDGET_CHARS },
    ]) expect(refusal(forged)).toBe(false);
  });

  it("privateEvidenceAnswer carries the two counts and the fixed marker only for a refusal the counts prove, and never any text", async () => {
    const f = await fixture();
    try {
      const source = { artifacts: f.h.cp.artifacts, audit: f.h.cp.audit };
      const answer = (evidence: Args) => privateEvidenceAnswer(source, f.run.runId,
        allow(ReasonCode.OK, { stage: "REVIEW_UNAVAILABLE", reasonCode: "EVIDENCE_MISSING", detail: { message: MARKER, evidence } }) as never);
      const kept = answer({ problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 142_367, budget: REVIEW_PROMPT_BUDGET_CHARS, note: MARKER });
      expect(kept).toMatchObject({ allowed: true, value: { promptBudget: { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 142_367, budget: REVIEW_PROMPT_BUDGET_CHARS, deterministic: true } } });
      expect(JSON.stringify(kept)).not.toContain(MARKER);
      for (const evidence of [{ problem: "OTHER", overhead: 142_367, budget: REVIEW_PROMPT_BUDGET_CHARS },
        { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: MARKER, budget: REVIEW_PROMPT_BUDGET_CHARS },
        { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: 5, budget: REVIEW_PROMPT_BUDGET_CHARS },
        { problem: REVIEW_PROMPT_BUDGET_PROBLEM, overhead: -1, budget: REVIEW_PROMPT_BUDGET_CHARS }]) {
        expect(JSON.stringify(answer(evidence))).not.toContain("promptBudget");
      }
    } finally { await f.close(); }
  });
});
