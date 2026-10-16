import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { bootstrapCoverageKeys, bootstrapPlan, callCtoToolAsOwner, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, dispatchBootstrapRun, makeHarness, reviewerPass, reviewerRevise } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * PR #1114 review round 1 (BOOT-01..03), the reviewer's witnesses kept in the repository: a re-plan
 * replaces every unexecuted task of the superseded PLAN, and is all-or-nothing; a bootstrap PLAN
 * carries one task; and each revision cycle — a CEO FINAL_REVISE, a blind-review REVISE — is its own
 * delivery, whose refusal is not ignored. Every case acts through the owner's MCP tools.
 */

const contract = {
  goal: "bootstrap",
  why: "new repository",
  scope: [],
  nonGoals: [],
  acceptance: ["repository created"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};
let seq = 0;

const fixture = async () => {
  const h = makeHarness();
  bindCeo(h);
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  await dispatchBootstrapRun(h.cp, h.clock, runId);
  const call = (name: string, args: Record<string, unknown>) =>
    callCtoToolAsOwner(h, runId, name, { idempotencyKey: `review-${++seq}`, runId, ...args });
  return { h, runId, call };
};

const revisionRequests = (h: ReturnType<typeof makeHarness>, runId: string) =>
  h.cp.outbox.listByRun(runId).filter((message) => message.kind === "REVISION_REQUEST");

describe("BOOT-01: a re-plan cancels every unexecuted task of the superseded PLAN; a bootstrap PLAN carries one task", () => {
  it("a corrective one-task PLAN cancels every unexecuted task of the superseded graph", async () => {
    const { h, runId, call } = await fixture();
    // The superseded graph is one accepted before the one-task restriction (run_7717's era): stored
    // the way plan_submit stored it then, a PLAN and then its two-task graph.
    const port = createCtoMcpPort(h.cp);
    expect(port.submitPlan(runId, bootstrapPlan(cleanTreeManifest("review-pending"), { summary: "P1" })).allowed).toBe(true);
    expect(h.cp.tasks.submit(runId, [
      { key: "create", title: "create repository", category: "implementation" },
      { key: "check", title: "check repository", category: "test", dependsOn: ["create"] },
    ]).allowed).toBe(true);
    expect(h.cp.tasks.list(runId).map((t) => t.state)).toEqual(["READY", "PENDING"]);
    const second = await call("plan_submit", {
      plan: bootstrapPlan(cleanTreeManifest("review-pending"), { summary: "P2 one create task" }),
      tasks: [{ key: "create", title: "create repository", category: "implementation" }],
    });
    expect(second.body, second.text).toMatchObject({ ok: true });
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const result = await call("result_submit", { resultSummary: "P2 prepared", recommendation: "create repository" });
    expect(h.cp.tasks.list(runId).map((t) => t.state)).toEqual(["CANCELLED", "CANCELLED", "READY"]);
    expect(result.body, result.text).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
  });

  it("plan_submit refuses a multi-task or dependent bootstrap graph, and stores neither its PLAN nor its tasks", async () => {
    const { h, runId, call } = await fixture();
    for (const tasks of [
      [
        { key: "create", title: "create repository", category: "implementation" },
        { key: "check", title: "check repository", category: "test", dependsOn: ["create"] },
      ],
      [{ key: "create", title: "create repository", category: "implementation", dependsOn: ["earlier"] }],
    ]) {
      const submitted = await call("plan_submit", { plan: bootstrapPlan(cleanTreeManifest("review-one-task")), tasks });
      expect(submitted.body, submitted.text).toMatchObject({ ok: false, evidence: { refusal: "BOOTSTRAP_PLAN_TASK_COUNT" } });
    }
    expect(h.cp.artifacts.latest(runId, "PLAN")).toBeNull();
    expect(h.cp.tasks.list(runId)).toEqual([]);
  });
});

describe("BOOT-02: a refused re-plan changes nothing", () => {
  it("a refused re-plan leaves its PLAN and task binding unchanged", async () => {
    const { h, runId, call } = await fixture();
    const plan = bootstrapPlan(cleanTreeManifest("review-atomic"), { summary: "P1" });
    expect((await call("plan_submit", { plan, tasks: [{ key: "create", title: "create repository", category: "implementation" }] })).body)
      .toMatchObject({ ok: true });
    const before = h.cp.artifacts.latest(runId, "PLAN")!.digest;
    const tasksBefore = h.cp.tasks.list(runId);
    const second = await call("plan_submit", {
      plan: { ...plan, summary: "P2" },
      tasks: [{ key: "create", title: "create repository", category: "implementation", dependsOn: ["missing"] }],
    });
    expect(second.body).toMatchObject({ ok: false });
    expect(h.cp.artifacts.latest(runId, "PLAN")!.digest).toBe(before);
    expect(h.cp.tasks.list(runId)).toEqual(tasksBefore);
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const result = await call("result_submit", { resultSummary: "prepared", recommendation: "create repository" });
    expect(result.body, result.text).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
  });
});

describe("ROUND1-ESCAPE-01: re-submitting an earlier stored PLAN is refused, never silently kept behind the current one", () => {
  it("P1, P2, then P1 again: the third plan_submit is refused with both digests; tasks, binding and the review stay on P2", async () => {
    const { h, runId, call } = await fixture();
    const task = [{ key: "create", title: "create repository", category: "implementation" }];
    const first = bootstrapPlan(cleanTreeManifest("review-replayed"), { summary: "P1" });
    expect((await call("plan_submit", { plan: first, tasks: task })).body).toMatchObject({ ok: true });
    const firstDigest = h.cp.artifacts.latest(runId, "PLAN")!.digest;
    const secondManifest = cleanTreeManifest("review-replayed");
    secondManifest.verificationCommands = secondManifest.verificationCommands.map((c) => ({ ...c, timeoutSeconds: 1200, maxMemoryMb: 4096 }));
    expect((await call("plan_submit", { plan: bootstrapPlan(secondManifest, { summary: "P2" }), tasks: task })).body).toMatchObject({ ok: true });
    const secondDigest = h.cp.artifacts.latest(runId, "PLAN")!.digest;
    expect(secondDigest).not.toBe(firstDigest);
    const tasksBefore = h.cp.tasks.list(runId);
    const bindingsBefore = h.cp.audit.byKind("BOOTSTRAP_PLAN_TASKS").filter((row) => row.runId === runId).map((row) => row.evidence);

    const replayed = await call("plan_submit", { plan: first, tasks: task });
    expect(replayed.body, replayed.text).toMatchObject({
      ok: false,
      evidence: { refusal: "BOOTSTRAP_PLAN_RESUBMITTED_NOT_CURRENT", currentPlanDigest: secondDigest, resubmittedPlanDigest: firstDigest },
    });
    expect(h.cp.artifacts.latest(runId, "PLAN")!.digest).toBe(secondDigest);
    expect(h.cp.tasks.list(runId)).toEqual(tasksBefore);
    expect(h.cp.audit.byKind("BOOTSTRAP_PLAN_TASKS").filter((row) => row.runId === runId).map((row) => row.evidence)).toEqual(bindingsBefore);
    expect(bindingsBefore.at(-1)).toMatchObject({ planDigest: secondDigest });

    // The current PLAN is still P2, and result_submit reviews exactly that.
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const result = await call("result_submit", { resultSummary: "prepared", recommendation: "create repository" });
    expect(result.body, result.text).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
    const candidate = h.cp.artifacts.latest<{ bootstrapPlan?: { planDigest?: string } }>(runId, "CANDIDATE_SNAPSHOT")!;
    expect(candidate.content.bootstrapPlan?.planDigest).toBe(secondDigest);
  });

  it("re-submitting the current PLAN is still accepted", async () => {
    const { h, runId, call } = await fixture();
    const task = [{ key: "create", title: "create repository", category: "implementation" }];
    const plan = bootstrapPlan(cleanTreeManifest("review-replayed-current"), { summary: "P1" });
    expect((await call("plan_submit", { plan, tasks: task })).body).toMatchObject({ ok: true });
    const digest = h.cp.artifacts.latest(runId, "PLAN")!.digest;
    expect((await call("plan_submit", { plan, tasks: task })).body).toMatchObject({ ok: true });
    expect(h.cp.artifacts.latest(runId, "PLAN")!.digest).toBe(digest);
    expect(h.cp.tasks.list(runId).map((t) => t.state)).toEqual(["CANCELLED", "READY"]);
  });
});

describe("BOOT-03: each revision cycle is its own delivery", () => {
  it.each(["Second revision reason", "First revision reason"])(
    "a second FINAL_REVISE of the same PLAN delivers the current CEO rationale: %s",
    async (rationale) => {
      const { h, runId, call } = await fixture();
      const plan = bootstrapPlan(cleanTreeManifest("review-revision-key"));
      expect((await call("plan_submit", { plan, tasks: [{ key: "create", title: "create repository", category: "implementation" }] })).body)
        .toMatchObject({ ok: true });
      const result = async () => {
        h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
        const submitted = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
        expect(submitted.body, submitted.text).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
        return h.cp.runs.currentCandidate(runId)!;
      };
      const ceoSessionId = h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;
      const firstCandidate = await result();
      const first = h.cp.ceo.submitCeoDecision({ runId, decision: "FINAL_REVISE", candidateSnapshotDigest: firstCandidate, ceoSessionId, rationale: "First revision reason" });
      expect(first).toMatchObject({ allowed: true });
      const firstMessage = revisionRequests(h, runId)[0]!;
      expect((await call("run_ack", { messageId: firstMessage.messageId })).body).toMatchObject({ ok: true });
      await dispatchBootstrapRun(h.cp, h.clock, runId);
      expect((await call("plan_submit", { plan, tasks: [{ key: "create-again", title: "create repository", category: "implementation" }] })).body)
        .toMatchObject({ ok: true });
      const secondCandidate = await result();
      expect(secondCandidate).toBe(firstCandidate);
      const second = h.cp.ceo.submitCeoDecision({ runId, decision: "FINAL_REVISE", candidateSnapshotDigest: secondCandidate, ceoSessionId, rationale });
      expect(second).toMatchObject({ allowed: true, value: { state: RunState.REVISION_REQUIRED } });
      // Two deliveries, one per cycle: the first acknowledged, the second pending with the current rationale.
      // (`listByRun` does not order rows created at one fixed-clock instant, so this compares as a set.)
      const deliveries = revisionRequests(h, runId).map((m) => ({ rationale: (m.payload as Record<string, unknown>)["rationale"], status: m.status }));
      expect(deliveries).toHaveLength(2);
      expect(deliveries).toEqual(expect.arrayContaining([
        { rationale: "First revision reason", status: "ACKED" },
        { rationale, status: "PENDING" },
      ]));
    },
  );

  it("the blind-review revision sibling delivers a second verdict on the same PLAN", async () => {
    const { h, runId, call } = await fixture();
    const plan = bootstrapPlan(cleanTreeManifest("review-blind-revision"));
    for (const reason of ["First review reason", "Second review reason"]) {
      expect((await call("plan_submit", { plan, tasks: [{ key: "create", title: "create repository", category: "implementation" }] })).body)
        .toMatchObject({ ok: true });
      h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(bootstrapCoverageKeys(h, runId), reason) });
      const submitted = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
      expect(submitted.body, submitted.text).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
      for (const message of revisionRequests(h, runId).filter((m) => m.status !== "ACKED")) {
        expect((await call("run_ack", { messageId: message.messageId })).body).toMatchObject({ ok: true });
      }
    }
    expect(revisionRequests(h, runId)).toHaveLength(2);
  });

  it("a blind-review REVISE whose revision cannot be delivered is answered as a refusal, not as REVISION_REQUIRED", async () => {
    const { h, runId, call } = await fixture();
    expect((await call("plan_submit", {
      plan: bootstrapPlan(cleanTreeManifest("review-blind-refused")),
      tasks: [{ key: "create", title: "create repository", category: "implementation" }],
    })).body).toMatchObject({ ok: true });
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(bootstrapCoverageKeys(h, runId), "a reason") });
    const enqueue = h.cp.outbox.enqueue.bind(h.cp.outbox);
    vi.spyOn(h.cp.outbox, "enqueue").mockImplementation((input) =>
      input.kind === "REVISION_REQUEST"
        ? deny(ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH, "injected delivery refusal", {})
        : enqueue(input));
    const submitted = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
    expect(submitted.body, submitted.text).toMatchObject({ ok: false, reasonCode: ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH });
    expect(revisionRequests(h, runId)).toEqual([]);
  });
});
