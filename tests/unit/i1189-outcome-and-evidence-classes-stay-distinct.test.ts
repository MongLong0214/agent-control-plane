import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { AgentOwnedWaits, DEFAULT_AGENT_WAIT_DEADLINES } from "../../src/ceo/agent-owned-waits.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunState, roleKeyFor, type RunRow } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { assessBaselineMinimum, RunEvidenceExporter } from "../../src/export/run-evidence.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import type { ProjectCi } from "../../src/registry/project-ci.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import { UNJUDGED_REVIEW_NEXT_STEPS, UNJUDGED_REVIEW_NOTICES } from "../../src/run/candidate-pipeline.ts";
import { cleanupTempDirs, gitSync } from "../helpers/fixtures.ts";
import {
  type Harness,
  applyFailingChange,
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 §11 and §12, on the path that generates and delivers results: the result_submit answer, the
 * REVISION_REQUEST the owning CTO reads with role_dispatch_pending, the CEO's notifications, and the
 * completion and CI readbacks (the run evidence export, project_get). Every value is synthetic, and
 * the reviewer is the harness's scripted one: these are scripted pipeline results, not live evidence.
 */

const MINUTE = 60_000;
type Args = Record<string, unknown>;

const prepare = async (h: Harness, failing = false, manifest: Partial<ProjectManifest> = {}) => {
  const { projectId, repositoryId, identity } = await registerFixtureProject(h, "fixture-project", manifest);
  bindCeo(h);
  const created = h.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: "make app() return 2",
      why: "downstream callers expect 2",
      scope: ["src/app.js"],
      nonGoals: [],
      acceptance: ["verify.js exits 0"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head = failing ? applyFailingChange(h.repoPath) : applyPassingChange(h.repoPath);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  return { run, projectId, identity, covered: `${identity}:src/app.js` };
};

/** One MCP connection as the run's owning CTO session: the door result_submit and role_dispatch_pending use. */
const ctoConnection = async (h: Harness, run: RunRow) => {
  const sessionId = run.ownerSessionId!;
  const incarnation = h.cp.sessions.require(sessionId).incarnation;
  const held = h.cp.bindings.bySession(sessionId).filter((binding) => binding.status === "ACTIVE");
  const server = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, {
    actor: `cto:${sessionId}`, sessionId, sessionIncarnation: incarnation,
    binding: { roleKey: held[0]!.roleKey, bindingGeneration: held[0]!.bindingGeneration },
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "i1189-outcome-classes", version: "1" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Args = {}): Promise<Args> => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
  };
  const submit = (idempotencyKey: string) =>
    call("result_submit", { idempotencyKey, runId: run.runId, resultSummary: "app() now returns 2", recommendation: "merge" });
  /**
   * The REVISION_REQUESTs addressed to this session, oldest first: the outbox rows the delivery loop sends
   * (`role_dispatch_pending` lists the same rows in band only for an adopted canonical CTO).
   */
  const revisions = async (): Promise<Array<{ messageId: string; payload: Args }>> => {
    const queued = h.cp.db.all<{ message_id: string }>(
      "SELECT message_id FROM outbox WHERE run_id = ? AND kind = ? AND target_session_id = ? ORDER BY rowid", [run.runId, MessageKind.REVISION_REQUEST, sessionId]);
    const byId = new Map(h.cp.outbox.listByRun(run.runId).map((message) => [message.messageId, message]));
    return queued.map(({ message_id }) => ({ messageId: message_id, payload: byId.get(message_id)!.payload as Args }));
  };
  const close = async (): Promise<void> => {
    await client.close();
    await server.close();
  };
  return { client, call, submit, revisions, close };
};

const ceoNotifications = (h: Harness, runId: string): Args[] =>
  h.cp.outbox.listByRun(runId).filter((message) => message.kind === "CEO_NOTIFICATION").map((message) => message.payload as Args);

const attemptIds = (h: Harness, runId: string): string[] =>
  h.cp.audit.forRun(runId).filter((row) => row.kind === "CANDIDATE_FROZEN").map((row) => row.evidence["attemptId"] as string);

const blockVerdict = (covered: string): string => JSON.stringify({
  verdict: "BLOCK",
  coveredFiles: [covered],
  omittedItems: [],
  findings: [{ category: "correctness", severity: "BLOCKER", repository: "github:acme/fixture", path: "src/app.js",
    summary: "synthetic blocker", detail: "synthetic blocker detail" }],
});

describe("#1189 §11: each outcome reaches its recipient as itself, with its own next action", () => {
  it("a failed verification and a BLOCK verdict reach the owning CTO as two different revisions, in the answer and in the delivered payload", async () => {
    const h = makeHarness();
    const { run, covered } = await prepare(h, true);
    const cto = await ctoConnection(h, run);
    try {
      // The candidate fails its verification command: no review is run.
      const failed = await cto.submit("submit-failing");
      expect(failed, JSON.stringify(failed).slice(0, 400)).toMatchObject({ ok: true, value: { stage: "VERIFICATION_FAILED", report: { status: "FAIL" } } });
      const failedValue = failed["value"] as Args;
      expect(failedValue).not.toHaveProperty("review");
      expect(String(failedValue["reasonCode"])).not.toMatch(/^REVIEW_/);

      // Repaired, the next candidate passes verification and the reviewer blocks it.
      applyPassingChange(h.repoPath);
      h.scripted.script({ match: /Candidate review/, text: blockVerdict(covered) });
      const blocked = await cto.submit("submit-blocked");
      expect(blocked, JSON.stringify(blocked).slice(0, 400)).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED", reasonCode: ReasonCode.REVIEW_BLOCK, review: { verdict: "BLOCK" } } });
      const blockedValue = blocked["value"] as Args;
      expect(blockedValue).not.toHaveProperty("report");
      expect(blockedValue["snapshotDigest"]).not.toBe(failedValue["snapshotDigest"]);

      // What the CTO reads in band: one revision per outcome, each carrying its own stage, reason and evidence.
      const [first, second, ...rest] = await cto.revisions();
      expect(rest).toEqual([]);
      const [verificationAttempt, reviewAttempt] = attemptIds(h, run.runId);
      expect(first!.payload).toMatchObject({
        runId: run.runId, stage: "verification", reasonCode: failedValue["reasonCode"],
        candidateSnapshotDigest: failedValue["snapshotDigest"], report: { status: "FAIL", candidateSnapshotDigest: failedValue["snapshotDigest"] },
      });
      for (const reviewOnly of ["verdict", "packet", "findings", "notice", "nextStep"]) expect(first!.payload).not.toHaveProperty(reviewOnly);
      expect(second!.payload).toMatchObject({
        runId: run.runId, stage: "blind-review", reasonCode: ReasonCode.REVIEW_BLOCK, candidateSnapshotDigest: blockedValue["snapshotDigest"],
      });
      for (const verificationOnly of ["report", "notice", "nextStep"]) expect(second!.payload).not.toHaveProperty(verificationOnly);
      // Each is keyed by the submission attempt that produced it.
      const keys = h.cp.db.all<{ message_id: string; idempotency_key: string }>(
        "SELECT message_id, idempotency_key FROM outbox WHERE run_id = ? AND kind = 'REVISION_REQUEST' ORDER BY rowid", [run.runId]);
      expect(keys).toEqual([
        { message_id: first!.messageId, idempotency_key: `revision:${run.runId}:${String(failedValue["snapshotDigest"])}:${String(failedValue["reasonCode"])}:${verificationAttempt}` },
        { message_id: second!.messageId, idempotency_key: `revision:${run.runId}:${String(blockedValue["snapshotDigest"])}:${ReasonCode.REVIEW_BLOCK}:${reviewAttempt}` },
      ]);

      // Neither is the CEO's: the revision loop stays with the CTO, and the run stays ACTIVE.
      expect(ceoNotifications(h, run.runId)).toEqual([]);
      expect(h.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
    } finally {
      await cto.close();
      h.cp.close();
    }
  });

  it("a submission whose outcome is unknown goes to the CEO as possibly run; an unavailable review goes to the CTO as a resubmit notice", async () => {
    const h = makeHarness();
    const { run } = await prepare(h);

    // A submission is mid-review when the daemon goes: its review never answers, and its outcome is unknown.
    let entered!: () => void;
    const reviewing = new Promise<void>((resolve) => { entered = resolve; });
    h.scripted.invoke = async (_request: InvocationRequest): Promise<InvocationResult> => {
      entered();
      return new Promise<never>(() => undefined);
    };
    const during = await ctoConnection(h, run);
    void during.submit("running-at-the-restart").catch(() => undefined);
    await reviewing;
    await during.close();
    h.cp.close();

    const restarted = makeHarness({ root: h.root, repoPath: h.repoPath, clock: h.clock });
    const cto = await ctoConnection(restarted, run);
    try {
      const interruptedAttempt = attemptIds(restarted, run.runId).at(-1)!;
      const ceoBefore = ceoNotifications(restarted, run.runId).length;
      // The CTO asking again with the same key is told the outcome is unknown, and nothing runs again.
      expect(await cto.submit("running-at-the-restart")).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN });
      // Its lease lapses and the watchdog reclaims it; the daemon routes what the tick found (daemon.ts, #1189 C2):
      // the CEO is told the attempt may have run, and to read its records before anything is submitted again.
      const waits = new AgentOwnedWaits({ db: restarted.cp.db, clock: restarted.cp.clock, audit: restarted.cp.audit, runs: restarted.cp.runs,
        bindings: restarted.cp.bindings, outbox: restarted.cp.outbox, artifacts: restarted.cp.artifacts, gate: restarted.cp.ceo }, DEFAULT_AGENT_WAIT_DEADLINES);
      restarted.clock.advance(31 * MINUTE);
      waits.routeWatchdogStalls((await restarted.cp.watchdog.tick()).stalls);
      const told = ceoNotifications(restarted, run.runId).slice(ceoBefore).filter((notice) => notice["stall"] === "candidate_pipeline_attempt");
      expect(told, JSON.stringify(told).slice(0, 800)).toHaveLength(1);
      expect(told[0]).toMatchObject({ notification: "CRITICAL_SYSTEM_FAILURE", stall: "candidate_pipeline_attempt", resource: interruptedAttempt,
        effects: "MAY_HAVE_RUN", checkBeforeRerun: true, productFailure: false });
      // The CTO is sent nothing for it: no revision and no review-unavailable notice, and no unavailable review is recorded.
      expect(await cto.revisions()).toEqual([]);
      expect(restarted.cp.audit.forRun(run.runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE")).toEqual([]);

      // A fresh submission whose review cannot be constituted: the CTO gets the answer and the fixed notice.
      restarted.scripted.setRuntimeHealth("UNAVAILABLE");
      const ceoAfterReclaim = ceoNotifications(restarted, run.runId).length;
      const unavailable = await cto.submit("a-fresh-key");
      expect(unavailable, JSON.stringify(unavailable).slice(0, 400)).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE" } });
      const value = unavailable["value"] as Args;
      expect(value["reasonCode"]).not.toBe(ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN);
      const freshAttempt = attemptIds(restarted, run.runId).at(-1)!;
      expect(freshAttempt).not.toBe(interruptedAttempt);
      const notices = await cto.revisions();
      expect(notices.map((notice) => notice.payload)).toEqual([{
        runId: run.runId, reasonCode: value["reasonCode"], stage: "review-unavailable", candidateSnapshotDigest: value["snapshotDigest"],
        attemptId: freshAttempt, notice: "REVIEW_UNAVAILABLE", unjudgedAttempts: 1, unjudgedAttemptLimit: 2, nextStep: "RESUBMIT",
        recovery: `${UNJUDGED_REVIEW_NOTICES.REVIEW_UNAVAILABLE} ${UNJUDGED_REVIEW_NEXT_STEPS.RESUBMIT}`,
      }]);
      // Only the fresh attempt's review is recorded unavailable, and the CEO hears nothing of it.
      expect(restarted.cp.audit.forRun(run.runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE").map((row) => row.evidence["attemptId"]))
        .toEqual([freshAttempt]);
      expect(ceoNotifications(restarted, run.runId)).toHaveLength(ceoAfterReclaim);
    } finally {
      await cto.close();
      restarted.cp.close();
    }
  });
});

const CI_WORKFLOW = {
  path: ".github/workflows/ci.yml",
  // The same name as the manifest's local verification command, so a local PASS row names this check.
  checkName: "verify",
  repositoryRole: "primary",
  approvedDigest: "sha256:approved-ci",
  unapprovedFirstActivation: false,
};

const projectCi = async (h: Harness, projectId: string): Promise<ProjectCi> => {
  const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: "operator" }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "i1189-evidence-classes", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "project_get", arguments: { projectId } });
    const body = result.structuredContent as { ok: boolean; value: { ci: ProjectCi } };
    expect(body.ok).toBe(true);
    return body.value.ci;
  } finally {
    await client.close();
    await server.close();
  }
};

describe("#1189 §12: a scripted PASS alone never marks live CI or post-merge complete", () => {
  it("a scripted review PASS over a local verification PASS, then CONFIRM, leaves the CI check unobserved, post-merge unverified and the completion record incomplete", async () => {
    const h = makeHarness();
    const { run, projectId, identity, covered } = await prepare(h, false, { ciWorkflows: [CI_WORKFLOW] });
    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]) });
    const cto = await ctoConnection(h, run);
    try {
      const passed = await cto.submit("submit-pass");
      expect(passed, JSON.stringify(passed).slice(0, 400)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      const candidate = (passed["value"] as Args)["snapshotDigest"] as string;
      const candidateHead = gitSync(h.repoPath, ["rev-parse", "HEAD"]).trim();

      // The scripted evidence keeps its class and its binding: local rows for this run, candidate and head,
      // and a review from the scripted provider.
      const rows = h.cp.db.all<Args>(
        "SELECT run_id, candidate_snapshot_digest, command_id, source, exact_head, status FROM verification_results WHERE run_id = ?", [run.runId]);
      expect(rows).toEqual([{ run_id: run.runId, candidate_snapshot_digest: candidate, command_id: CI_WORKFLOW.checkName, source: "local",
        exact_head: candidateHead, status: "PASS" }]);
      expect(h.cp.review.latestPacket(run.runId, candidate)).toMatchObject({ verdict: "PASS", provider: "scripted", candidateSnapshotDigest: candidate });

      // The CEO confirms it: approval is not merge and not post-merge verification.
      const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      const confirmed = h.cp.ceo.submitCeoDecision({ runId: run.runId, decision: "CONFIRM", candidateSnapshotDigest: candidate,
        ceoSessionId: ceo.sessionId, rationale: "the scripted review passed" });
      expect(confirmed, JSON.stringify(confirmed).slice(0, 400)).toMatchObject({ allowed: true, value: { state: RunState.CEO_APPROVED } });

      // Live CI readback: the local PASS named like the check is not a CI observation.
      const ci = await projectCi(h, projectId);
      expect(ci).toMatchObject({ declared: true });
      if (!ci.declared) throw new Error("unreachable: asserted declared above");
      expect(ci.workflows).toMatchObject([{ checkName: CI_WORKFLOW.checkName, repositoryIdentity: identity, lastObserved: null,
        latestNonResult: null, unobserved: true, unobservedReason: "NO_RECORDED_OBSERVATION" }]);

      // Post-merge: nothing this run merged produced the candidate head, so no post-merge receipt can be written for it.
      expect((await h.cp.github.postMergeVerify(run.runId, identity, candidateHead)).reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
      expect(h.cp.db.all("SELECT receipt_id FROM github_receipts WHERE run_id = ?", [run.runId])).toEqual([]);

      // Completion record: the scripted facts are present and the merge, post-merge and final-outcome facts are not.
      const exported = new RunEvidenceExporter(h.cp.db, h.cp.artifacts, h.cp.clock, h.cp.audit).exportRun(run.runId);
      if (!exported.allowed) throw new Error(`${exported.reasonCode}: ${exported.message}`);
      expect(exported.value.run.state).toBe(RunState.CEO_APPROVED);
      const quality = exported.value.baseline.quality as Args;
      expect(Object.fromEntries((quality["facts"] as Array<{ name: string; present: boolean }>).map((fact) => [fact.name, fact.present])))
        .toMatchObject({ deterministicVerification: true, blindReview: true, ceoDecision: true, mergeReceipt: false, postMergeVerification: false, finalOutcome: false });
      expect(quality).toMatchObject({ postMergeVerification: "UNAVAILABLE", finalOutcome: { availability: "UNAVAILABLE" }, complete: false });
      // A scripted run is not production evidence, and an approved run is not a completion.
      expect(assessBaselineMinimum([exported.value]).observed).toMatchObject({ productionAttestedRuns: 0, falseCompletions: 0 });
    } finally {
      await cto.close();
      h.cp.close();
    }
  });
});
