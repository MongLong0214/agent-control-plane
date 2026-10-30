import { afterAll, describe, expect, it, vi } from "vitest";

import {
  AGENT_WAIT_DEADLINE,
  AgentOwnedWaits,
  type AgentWaitDeadlines,
  CEO_REVIEW_REDELIVERED,
  DEFAULT_AGENT_WAIT_DEADLINES,
} from "../../src/ceo/agent-owned-waits.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { OWNERLESS_STALL_ROUTED, type WatchdogTick } from "../../src/doctor/watchdog.ts";
import { ExecutionMode, Role, type RunRow, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { OutboxMessage } from "../../src/outbox/outbox.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  type Harness,
  bindCeo,
  bindWorker,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 — the CEO's rulings 3, 4 and 5 on the audit of waits that depend on a person:
 *
 * - B1: OWNER_DECISION_REQUIRED, with or without a human gate, names an owner-only reason (PRD §21) and
 *   the action it blocks; a CEO-scope judgement is refused with the CEO's own path; nothing forces CONFIRM;
 * - B4/B6/B7/B10: an agent-owned wait has a deadline that re-notifies, then reassigns (or attempts a
 *   recovery), then escalates to the CEO as CRITICAL_SYSTEM_FAILURE, and never becomes FAILED; after a CEO
 *   recovery the pending reviews are delivered again, deduplicated by the decision and the current
 *   candidate, never by an earlier holder's ACK;
 * - B12/C2: a stall nobody watches reaches the CEO as CRITICAL_SYSTEM_FAILURE with its owner, recovery
 *   action and blocker; a delivery timeout is not a product failure.
 */

const HOUR = 60 * 60 * 1000;

const waitsOf = (harness: Harness, deadlines: Partial<AgentWaitDeadlines> = {}): AgentOwnedWaits =>
  new AgentOwnedWaits({
    db: harness.cp.db,
    clock: harness.cp.clock,
    audit: harness.cp.audit,
    runs: harness.cp.runs,
    bindings: harness.cp.bindings,
    outbox: harness.cp.outbox,
    artifacts: harness.cp.artifacts,
    gate: harness.cp.ceo,
  }, { ...DEFAULT_AGENT_WAIT_DEADLINES, ...deadlines });

const ceoNotices = (harness: Harness, runId: string): OutboxMessage[] =>
  harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.CEO_NOTIFICATION);

const payloadOf = (message: OutboxMessage | undefined): Record<string, unknown> =>
  (message?.payload ?? {}) as Record<string, unknown>;

const ceoSession = (harness: Harness): string => harness.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;

/** The CEO role recovered onto a new runtime: the old binding revoked, a new session bound. */
const recoverCeo = (harness: Harness): string => {
  expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
  return bindCeo(harness);
};

/** A CEO session the generic Buzz sweep can deliver to: its room, and who it is in that room. */
const withBuzzRoute = (harness: Harness, sessionId: string): string => {
  harness.cp.db.run(`UPDATE sessions SET buzz_address = 'ceo-room', buzz_actor_id = 'actor:ceo' WHERE session_id = ?`, [sessionId]);
  return sessionId;
};

/** A candidate pipeline attempt left RUNNING by a crashed CTO, started before the run's last progress. */
const insertAttempt = (harness: Harness, run: Pick<RunRow, "runId" | "ownerSessionId" | "ownerBindingGeneration">, at: { deadlineInMs: number }): void => {
  harness.cp.db.run(
    `INSERT INTO candidate_pipeline_attempts
       (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
     VALUES (?, 'attempt_crashed', ?, ?, NULL, 'RUNNING', ?, ?, NULL)`,
    [
      run.runId, run.ownerSessionId, run.ownerBindingGeneration,
      new Date(harness.clock.now().getTime() - 31 * 60 * 1000).toISOString(),
      new Date(harness.clock.now().getTime() + at.deadlineInMs).toISOString(),
    ],
  );
};

/** The owed stalls' settlements on the run (an OWNERLESS_STALL_ROUTED that says why it is settled). */
const stallSettlements = (harness: Harness, runId: string): Array<Record<string, unknown>> =>
  harness.cp.audit.forRun(runId)
    .filter((entry) => entry.kind === OWNERLESS_STALL_ROUTED && entry.evidence["settled"] !== undefined)
    .map((entry) => entry.evidence);

const ceoDecisions = (harness: Harness, runId: string) =>
  harness.cp.audit.forRun(runId).filter((entry) => entry.kind === "CEO_DECISION");

/** A real reviewed candidate with its production-ready packet: the run at READY_FOR_CEO_REVIEW. */
const atReview = async (harness: Harness) => {
  const driven = await driveToReviewedCandidate(harness);
  await harness.cp.continuity.evaluate("test");
  const packet = harness.cp.ceo.buildPacket({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "done",
      recommendation: "ship",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  return driven;
};

/** An ACTIVE run of a registered project, with a CEO bound. */
const activeRun = async (harness: Harness) => {
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
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
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  return dispatched.value;
};

describe("#1189 B1 — OWNER_DECISION_REQUIRED names an owner-only reason and the action it blocks", () => {
  it("is refused without an owner-only reason or without the blocked action, and the run stays at review", async () => {
    const harness = makeHarness();
    const driven = await atReview(harness);
    const base = {
      runId: driven.runId,
      decision: "OWNER_DECISION_REQUIRED" as const,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceoSession(harness),
      rationale: "the owner should look at this",
    };

    for (const input of [
      base,
      { ...base, ownerReason: "  " },
      { ...base, ownerReason: "THE_OWNER_SHOULD_KNOW", blockedAction: "merge" },
      { ...base, ownerReason: "DATA_LOSS" },
      { ...base, ownerReason: "DATA_LOSS", blockedAction: "x".repeat(201) },
    ]) {
      const refused = harness.cp.ceo.submitCeoDecision(input);
      expect(refused, JSON.stringify(input)).toMatchObject({ allowed: false, reasonCode: ReasonCode.OWNER_DECISION_REASON_REQUIRED });
    }
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(ceoDecisions(harness, driven.runId)).toEqual([]);
  });

  it("refuses a CEO-scope judgement with the CEO's own path, and forces no CONFIRM: the CEO decides as it would have", async () => {
    const harness = makeHarness();
    const driven = await atReview(harness);
    const base = {
      runId: driven.runId,
      decision: "OWNER_DECISION_REQUIRED" as const,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceoSession(harness),
      rationale: "I am not sure about this candidate",
      blockedAction: "merge the candidate",
    };
    for (const ownerReason of ["CANDIDATE_QUALITY", "TECHNICAL_APPROACH", "PRIORITY", "UNCERTAINTY", "RETRY_OR_RECOVERY", "STAFFING", "CANCELLATION"]) {
      const refused = harness.cp.ceo.submitCeoDecision({ ...base, ownerReason });
      expect(refused, ownerReason).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.OWNER_DECISION_CEO_SCOPE,
        evidence: { ownerReason, ceoPath: expect.any(String) },
      });
    }
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(ceoDecisions(harness, driven.runId)).toEqual([]);

    const revised = harness.cp.ceo.submitCeoDecision({ ...base, decision: "FINAL_REVISE", rationale: "the candidate needs a test" });
    expect(revised).toMatchObject({ allowed: true, value: { state: RunState.REVISION_REQUIRED } });
  });

  it("accepts an owner-only reason on a run with no human gate, and records the reason and the blocked action", async () => {
    const harness = makeHarness();
    const driven = await atReview(harness);
    expect(harness.cp.ceo.humanGateStatus(driven.runId)).toMatchObject({ required: false });
    const decided = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "OWNER_DECISION_REQUIRED",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceoSession(harness),
      rationale: "the change drops a column the owner's reporting reads",
      ownerReason: "DATA_LOSS",
      blockedAction: "merge the migration that drops reports.legacy_total",
    });
    expect(decided).toMatchObject({ allowed: true, value: { state: RunState.AWAITING_HUMAN } });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.AWAITING_HUMAN);
    const recorded = { ownerReason: "DATA_LOSS", blockedAction: "merge the migration that drops reports.legacy_total" };
    expect(ceoDecisions(harness, driven.runId).at(-1)?.evidence).toMatchObject({ decision: "OWNER_DECISION_REQUIRED", ...recorded });
    const transition = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1);
    expect(transition?.evidence).toMatchObject({ to: RunState.AWAITING_HUMAN, ...recorded });
  });
});

describe("#1189 B4/B6/B7/B10 — an agent-owned wait's deadline re-notifies, reassigns, then escalates to the CEO; nothing becomes FAILED", () => {
  it("an unresolved escalation: RENOTIFY at one deadline, REASSIGN to the recovered CEO at two, CRITICAL_SYSTEM_FAILURE at three, then nothing", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const opened = harness.cp.ceo.openEscalation({
      runId: run.runId,
      question: "which schema version does the importer target?",
      options: ["v1", "v2"],
      ctoRecommendation: "v2",
      whyItMatters: "the importer cannot be written against both",
      blocksCriticalPath: true,
      openedBySessionId: run.ownerSessionId!,
      openedAt: harness.clock.nowIso(),
    });
    expect(opened).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
    const escalationId = opened.allowed ? opened.value.escalationId : null;
    const firstCeo = ceoSession(harness);
    // The deadline is the daemon's configuration.
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-agent-waits-"), agentWaitDeadlines: { escalationMs: HOUR } });
    const notices = () => ceoNotices(harness, run.runId).filter((message) => payloadOf(message)["step"] !== undefined);

    expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([]);
    harness.clock.advance(HOUR - 1);
    expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([]);

    harness.clock.advance(1);
    expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([expect.objectContaining({ kind: "ESCALATION", step: "RENOTIFY" })]);
    expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([]);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ targetSessionId: firstCeo });
    expect(payloadOf(notices()[0])).toMatchObject({
      notification: "TRUE_ESCALATION", escalationId, question: "which schema version does the importer target?",
      step: "RENOTIFY", waitKind: "ESCALATION", owner: "CEO", productFailure: false,
    });

    const secondCeo = recoverCeo(harness);
    harness.clock.advance(HOUR);
    expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([expect.objectContaining({ kind: "ESCALATION", step: "REASSIGN" })]);
    const reassigned = notices().find((message) => payloadOf(message)["step"] === "REASSIGN");
    expect(reassigned).toMatchObject({ targetSessionId: secondCeo });
    expect(payloadOf(reassigned)).toMatchObject({ notification: "TRUE_ESCALATION", escalationId });

    harness.clock.advance(HOUR);
    expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([expect.objectContaining({ kind: "ESCALATION", step: "CEO_ESCALATION" })]);
    const critical = notices().find((message) => payloadOf(message)["step"] === "CEO_ESCALATION");
    expect(critical).toMatchObject({ targetSessionId: secondCeo });
    expect(payloadOf(critical)).toMatchObject({
      notification: "CRITICAL_SYSTEM_FAILURE",
      owner: "CEO",
      recoveryAction: expect.stringContaining(`escalation_resolve escalation ${escalationId}`),
      blocker: expect.stringContaining(`CTO escalation ${escalationId}`),
      productFailure: false,
    });

    harness.clock.advance(10 * HOUR);
    expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([]);
    expect(notices()).toHaveLength(3);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    const markers = harness.cp.audit.forRun(run.runId).filter((entry) => entry.kind === AGENT_WAIT_DEADLINE);
    expect(markers.map((entry) => entry.evidence["step"])).toEqual(["RENOTIFY", "REASSIGN", "CEO_ESCALATION"]);
    expect(markers[1]?.evidence).toMatchObject({ reassigned: true });
    expect(harness.cp.audit.forRun(run.runId).some((entry) => entry.kind === "RUN_TRANSITION" && entry.evidence["to"] === RunState.FAILED)).toBe(false);
  });

  it("after the ladder, an unresolved wait's CRITICAL_SYSTEM_FAILURE reaches a replacement CEO once, under the same correlation; a resolved one reaches no later CEO", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const opened = harness.cp.ceo.openEscalation({
      runId: run.runId,
      question: "which schema version does the importer target?",
      options: ["v1", "v2"],
      ctoRecommendation: "v2",
      whyItMatters: "the importer cannot be written against both",
      blocksCriticalPath: true,
      openedBySessionId: run.ownerSessionId!,
      openedAt: harness.clock.nowIso(),
    });
    expect(opened).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
    const escalationId = opened.allowed ? opened.value.escalationId! : -1;
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-agent-waits-redelivery-"), agentWaitDeadlines: { escalationMs: HOUR } });
    const critical = () => ceoNotices(harness, run.runId).filter((message) => payloadOf(message)["notification"] === "CRITICAL_SYSTEM_FAILURE");
    for (const step of ["RENOTIFY", "REASSIGN", "CEO_ESCALATION"]) {
      harness.clock.advance(HOUR);
      expect((await daemon.sweepAgentOwnedWaits()).taken).toEqual([expect.objectContaining({ step })]);
    }
    const [first] = critical();
    expect(critical()).toHaveLength(1);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(harness.cp.outbox.acknowledge(first!.messageId, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);
    harness.clock.advance(10 * HOUR);
    await daemon.sweepAgentOwnedWaits();
    // An ACK is a receipt, not a resolution, and the CEO that ACKed it is not told again.
    expect(critical()).toHaveLength(1);

    const replacement = recoverCeo(harness);
    for (let pass = 0; pass < 3; pass += 1) await daemon.sweepAgentOwnedWaits();
    expect(critical()).toHaveLength(2);
    const second = critical().find((message) => message.messageId !== first!.messageId);
    expect(second).toMatchObject({ targetSessionId: replacement });
    expect(payloadOf(second)).toMatchObject({
      redelivery: true,
      correlation: payloadOf(first)["correlation"],
      episode: payloadOf(first)["episode"],
      step: "CEO_ESCALATION",
      blocker: expect.stringContaining(`CTO escalation ${escalationId}`),
    });
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);

    // The CEO answers the escalation: the run leaves the wait, and a CEO bound after that is told nothing.
    expect(harness.cp.ceo.resolveEscalation(run.runId, "v2", replacement, { escalationId })).toMatchObject({ allowed: true });
    recoverCeo(harness);
    for (let pass = 0; pass < 3; pass += 1) await daemon.sweepAgentOwnedWaits();
    expect(critical()).toHaveLength(2);
  });

  it("a pending review, then the FINAL_REVISE not dispatched again, each take the ladder as their own wait and stay where they are", async () => {
    const harness = makeHarness();
    const driven = await atReview(harness);
    const waits = waitsOf(harness, { ceoReviewMs: HOUR, revisionMs: HOUR });
    const recover = vi.fn();

    harness.clock.advance(HOUR);
    expect((await waits.sweep(recover)).taken).toEqual([expect.objectContaining({ kind: "CEO_REVIEW", step: "RENOTIFY" })]);
    const reminded = ceoNotices(harness, driven.runId).find((message) => payloadOf(message)["step"] === "RENOTIFY");
    expect(payloadOf(reminded)).toMatchObject({
      notification: "READY_FOR_CEO_REVIEW", candidateSnapshotDigest: driven.candidateSnapshotDigest, waitKind: "CEO_REVIEW",
    });

    const revised = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId, decision: "FINAL_REVISE", candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceoSession(harness), rationale: "add a regression test",
    });
    expect(revised.allowed).toBe(true);
    // A new wait: its ladder starts at its own transition, not at the review's.
    expect((await waits.sweep(recover)).taken).toEqual([]);
    for (const step of ["RENOTIFY", "REASSIGN", "CEO_ESCALATION"]) {
      harness.clock.advance(HOUR);
      expect((await waits.sweep(recover)).taken).toEqual([expect.objectContaining({ kind: "REVISION", step })]);
    }
    const revision = ceoNotices(harness, driven.runId).filter((message) => payloadOf(message)["waitKind"] === "REVISION");
    expect(revision.map((message) => payloadOf(message)["notification"]))
      .toEqual(["TRUE_ESCALATION", "TRUE_ESCALATION", "CRITICAL_SYSTEM_FAILURE"]);
    expect(payloadOf(revision[0])).toMatchObject({ recoveryAction: expect.stringContaining("run_dispatch") });
    harness.clock.advance(24 * HOUR);
    expect((await waits.sweep(recover)).taken).toEqual([]);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.REVISION_REQUIRED);
    expect(recover).not.toHaveBeenCalled();
  });

  it("a continuity hold: its REASSIGN step is a recovery attempt (continuity's reconcile), and the hold is never failed", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const held = harness.cp.runs.pauseForContinuity(run.runId, run.ownerRoleKey!, "coverage lost", {
      roleKey: run.ownerRoleKey, continuityAction: "PAUSE_NEW_WORK",
    });
    expect(held).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
    const waits = waitsOf(harness, { continuityHoldMs: HOUR });
    const recover = vi.fn();

    harness.clock.advance(HOUR);
    expect((await waits.sweep(recover)).taken).toEqual([expect.objectContaining({ kind: "CONTINUITY_HOLD", step: "RENOTIFY" })]);
    expect(recover).not.toHaveBeenCalled();
    harness.clock.advance(HOUR);
    expect((await waits.sweep(recover)).taken).toEqual([expect.objectContaining({ kind: "CONTINUITY_HOLD", step: "REASSIGN", messageId: null })]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]?.[0]).toMatchObject({ kind: "CONTINUITY_HOLD", runId: run.runId, owner: run.ownerRoleKey });
    harness.clock.advance(HOUR);
    expect((await waits.sweep(recover)).taken).toEqual([expect.objectContaining({ kind: "CONTINUITY_HOLD", step: "CEO_ESCALATION" })]);
    const critical = ceoNotices(harness, run.runId).find((message) => payloadOf(message)["step"] === "CEO_ESCALATION");
    expect(payloadOf(critical)).toMatchObject({
      notification: "CRITICAL_SYSTEM_FAILURE", owner: run.ownerRoleKey, recoveryAction: expect.stringContaining("cto_replace"),
    });
    expect(harness.cp.runs.require(run.runId)).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: run.ownerRoleKey });
    // The notices are recorded under their own kinds, never as a run movement that would keep the hold.
    const kinds = harness.cp.audit.forRun(run.runId).map((entry) => entry.kind);
    expect(kinds).not.toContain("CEO_NOTIFICATION");
  });

  it("an owner decision's AWAITING_HUMAN is the owner's: no deadline step is ever taken for it", async () => {
    const harness = makeHarness();
    const driven = await atReview(harness);
    expect(harness.cp.ceo.submitCeoDecision({
      runId: driven.runId, decision: "OWNER_DECISION_REQUIRED", candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceoSession(harness), rationale: "a paid plan", ownerReason: "NEW_COST_OR_PAID_PLAN", blockedAction: "enable the paid tier",
    }).allowed).toBe(true);
    const waits = waitsOf(harness, { ceoReviewMs: HOUR, continuityHoldMs: HOUR });
    harness.clock.advance(10 * HOUR);
    expect(waits.waits()).toEqual([]);
    expect((await waits.sweep(vi.fn())).taken).toEqual([]);
  });
});

describe("#1189 B6 — after a CEO recovery, the pending reviews are delivered again: exactly the undecided current ones", () => {
  it("a review the replaced CEO ACKed is delivered once to the recovered CEO, for the current candidate only", async () => {
    const harness = makeHarness();
    const driven = await atReview(harness);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-agent-waits-") });
    const firstCeo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const original = ceoNotices(harness, driven.runId).find((message) => payloadOf(message)["notification"] === "READY_FOR_CEO_REVIEW")!;
    // A stale notice too: an earlier candidate's review, which the replaced CEO also ACKed.
    const stale = harness.cp.outbox.enqueue({
      idempotencyKey: `stale-review:${driven.runId}`,
      roleKey: firstCeo.roleKey,
      bindingGeneration: firstCeo.bindingGeneration,
      targetSessionId: firstCeo.sessionId,
      runId: driven.runId,
      kind: MessageKind.CEO_NOTIFICATION,
      payload: { notification: "READY_FOR_CEO_REVIEW", runId: driven.runId, candidateSnapshotDigest: "sha256:an-earlier-candidate" },
    });
    expect(stale.allowed).toBe(true);
    for (const messageId of [original.messageId, stale.allowed ? stale.value.messageId : ""]) {
      expect(harness.cp.outbox.acknowledge(messageId, firstCeo.sessionId, firstCeo.bindingGeneration).allowed).toBe(true);
    }
    // The holder that ACKed it has it: nothing is delivered again while it holds the role.
    expect((await daemon.sweepAgentOwnedWaits()).redelivered).toEqual([]);

    const secondCeo = recoverCeo(harness);
    const first = await daemon.sweepAgentOwnedWaits();
    expect(first.redelivered).toHaveLength(1);
    const redelivered = harness.cp.outbox.get(first.redelivered[0]!.messageId);
    expect(redelivered).toMatchObject({ targetSessionId: secondCeo, kind: MessageKind.CEO_NOTIFICATION, runId: driven.runId });
    expect(payloadOf(redelivered ?? undefined)).toMatchObject({
      notification: "READY_FOR_CEO_REVIEW",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      packetDigest: expect.any(String),
      redelivered: true,
    });
    expect((await daemon.sweepAgentOwnedWaits()).redelivered).toEqual([]);
    const toSecond = ceoNotices(harness, driven.runId).filter((message) => message.targetSessionId === secondCeo);
    expect(toSecond.map((message) => payloadOf(message)["candidateSnapshotDigest"])).toEqual([driven.candidateSnapshotDigest]);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === CEO_REVIEW_REDELIVERED)).toHaveLength(1);
  });

  it("a review still undelivered follows the recovered CEO by itself and is not duplicated; a decided review is never delivered again", async () => {
    const harness = makeHarness();
    const driven = await atReview(harness);
    const waits = waitsOf(harness);
    const secondCeo = recoverCeo(harness);
    // The unACKed notice moved to the new holder with its id (the outbox's own re-address).
    const notices = ceoNotices(harness, driven.runId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ targetSessionId: secondCeo });
    expect(waits.redeliverPendingReviews()).toEqual([]);

    expect(harness.cp.ceo.submitCeoDecision({
      runId: driven.runId, decision: "FINAL_REVISE", candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: secondCeo, rationale: "add a regression test",
    }).allowed).toBe(true);
    recoverCeo(harness);
    expect(waits.redeliverPendingReviews()).toEqual([]);
    expect(ceoNotices(harness, driven.runId).filter((message) => payloadOf(message)["notification"] === "READY_FOR_CEO_REVIEW")).toHaveLength(1);
  });
});

describe("#1189 B12/C2 — a stall nobody watches reaches the CEO as CRITICAL_SYSTEM_FAILURE", () => {
  it("the watchdog's overdue session and undelivered message are routed once each, with owner, recovery action and blocker; a delivery timeout fails nothing", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const stuck = harness.cp.sessions.create({ provider: "scripted", model: "never-starts" });
    const waits = waitsOf(harness);
    // The run's RUN_DISPATCH has not been delivered: no transport took it in this fixture.
    const dispatch = harness.cp.outbox.listByRun(run.runId).find((message) => message.kind === MessageKind.RUN_DISPATCH);
    expect(dispatch?.status).toBe("PENDING");

    harness.clock.advance(11 * 60 * 1000);
    const tick = await harness.cp.watchdog.tick();
    expect(tick.stalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session", id: stuck.sessionId }),
      expect.objectContaining({ kind: "outbox", id: dispatch!.messageId, runId: run.runId }),
    ]));
    const routed = waits.routeWatchdogStalls(tick.stalls);
    expect(routed.filter((entry) => entry.messageId !== null).map((entry) => entry.kind).sort()).toEqual(["outbox", "session"]);

    const critical = harness.cp.db.all<{ payload_json: string; target_session_id: string }>(
      `SELECT payload_json, target_session_id FROM outbox WHERE kind = 'CEO_NOTIFICATION'
         AND json_extract(payload_json, '$.notification') = 'CRITICAL_SYSTEM_FAILURE'`,
    ).map((row): Record<string, unknown> => ({ ...(JSON.parse(row.payload_json) as Record<string, unknown>), to: row.target_session_id }));
    expect(critical).toHaveLength(2);
    const sessionStall = critical.find((payload) => payload["stall"] === "session");
    expect(sessionStall).toMatchObject({
      to: ceoSession(harness), resource: stuck.sessionId, owner: { sessionId: stuck.sessionId },
      recoveryAction: expect.any(String), blocker: expect.stringContaining(stuck.sessionId), productFailure: false, deliveryTimeout: false,
    });
    const delivery = critical.find((payload) => payload["stall"] === "outbox");
    expect(delivery).toMatchObject({
      runId: run.runId, resource: dispatch!.messageId, owner: { role: dispatch!.roleKey },
      recoveryAction: expect.stringContaining("retry_outbox"), blocker: expect.stringContaining(dispatch!.messageId),
      deliveryTimeout: true, productFailure: false,
    });

    // The next tick finds the same stalls, and routes nothing again; the CEO notices now stuck are never routed.
    harness.clock.advance(11 * 60 * 1000);
    const again = await harness.cp.watchdog.tick();
    expect(again.stalls.some((stall) => stall.messageKind === MessageKind.CEO_NOTIFICATION)).toBe(true);
    expect(waits.routeWatchdogStalls(again.stalls).filter((entry) => entry.messageId !== null)).toEqual([]);
    expect(harness.cp.audit.byKind(OWNERLESS_STALL_ROUTED)).toHaveLength(2);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });

  it("a task execution gone quiet may have had effects: the notice says to check them first, and nothing is run again", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
    expect(submitted.allowed).toBe(true);
    const task = harness.cp.tasks.ready(run.runId)[0]!;
    const execution = harness.cp.tasks.startExecution({
      runId: run.runId,
      taskId: task.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: bindWorker(harness, task.taskId),
      provider: "scripted",
      model: "scripted-worker",
    });
    if (!execution.allowed) throw new Error(execution.message);
    harness.clock.advance(31 * 60 * 1000);
    const tick = await harness.cp.watchdog.tick();
    const quiet = tick.stalls.filter((stall) => stall.kind === "task_execution");
    expect(quiet).toEqual([expect.objectContaining({ id: execution.value.executionId, runId: run.runId })]);
    const [routed] = waitsOf(harness).routeWatchdogStalls(quiet);
    expect(routed?.messageId).toEqual(expect.any(String));
    expect(payloadOf(harness.cp.outbox.get(routed!.messageId!) ?? undefined)).toMatchObject({
      notification: "CRITICAL_SYSTEM_FAILURE",
      stall: "task_execution",
      resource: execution.value.executionId,
      owner: { role: run.ownerRoleKey, sessionId: run.ownerSessionId, generation: run.ownerBindingGeneration },
      effects: "MAY_HAVE_RUN",
      checkBeforeRerun: true,
      recoveryAction: expect.stringContaining("settle the execution before anything is run again"),
      productFailure: false,
    });
    expect(harness.cp.db.get<{ status: string }>(`SELECT status FROM task_executions WHERE execution_id = ?`, [execution.value.executionId]))
      .toEqual({ status: "RUNNING" });
    expect(harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ?`, [run.runId])).toEqual({ n: 1 });
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });

  it("F3-1: an idle run's stall is one episode however its notice is delivered, and a real run event starts the next", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    const runStalls = (tick: WatchdogTick) => tick.stalls.filter((stall) => stall.kind === "run");
    const alerts = () => ceoNotices(harness, run.runId).filter((message) =>
      payloadOf(message)["notification"] === "CRITICAL_SYSTEM_FAILURE" && payloadOf(message)["stall"] === "run");

    harness.clock.advance(121 * 60 * 1000);
    const first = runStalls(await harness.cp.watchdog.tick());
    expect(first).toHaveLength(1);
    waits.routeWatchdogStalls(first);
    await harness.cp.outbox.deliverCeoNotifications();
    // The CEO has no route in this fixture: delivering the notice writes its bookkeeping against the run.
    expect(harness.cp.audit.forRun(run.runId).some((entry) => entry.kind === "CEO_NOTIFICATION_ROUTE_UNAVAILABLE")).toBe(true);
    expect(alerts()).toHaveLength(1);

    harness.clock.advance(121 * 60 * 1000);
    const second = runStalls(await harness.cp.watchdog.tick());
    expect(second).toEqual([expect.objectContaining({ since: first[0]!.since })]);
    waits.routeWatchdogStalls(second);
    await harness.cp.outbox.deliverCeoNotifications();
    expect(alerts()).toHaveLength(1);

    // Real progress: the run's task graph. The run idles again after it, and that is a new episode.
    expect(harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]).allowed).toBe(true);
    const progressedAt = harness.clock.nowIso();
    harness.clock.advance(121 * 60 * 1000);
    const third = runStalls(await harness.cp.watchdog.tick());
    expect(third).toEqual([expect.objectContaining({ since: progressedAt })]);
    waits.routeWatchdogStalls(third);
    expect(alerts()).toHaveLength(2);
  });

  it("F3-2: a reclaimed attempt the CEO could not be told of reaches the CEO once it is back, exactly once", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    harness.cp.db.run(
      `INSERT INTO candidate_pipeline_attempts
         (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
       VALUES (?, 'attempt_crashed', ?, ?, NULL, 'RUNNING', ?, ?, NULL)`,
      [
        run.runId, run.ownerSessionId, run.ownerBindingGeneration,
        new Date(harness.clock.now().getTime() - 31 * 60 * 1000).toISOString(),
        new Date(harness.clock.now().getTime() - 60_000).toISOString(),
      ],
    );
    const attemptNotices = () => ceoNotices(harness, run.runId).filter((message) =>
      payloadOf(message)["notification"] === "CRITICAL_SYSTEM_FAILURE" && payloadOf(message)["stall"] === "candidate_pipeline_attempt");
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);

    const reclaimed = (await harness.cp.watchdog.tick()).stalls.filter((stall) => stall.kind === "candidate_pipeline_attempt");
    expect(reclaimed).toEqual([expect.objectContaining({ id: "attempt_crashed", runId: run.runId })]);
    expect(waits.routeWatchdogStalls(reclaimed)).toEqual([
      expect.objectContaining({ kind: "candidate_pipeline_attempt", messageId: null, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED }),
    ]);
    expect(attemptNotices()).toEqual([]);

    const ceo = bindCeo(harness);
    const later = await harness.cp.watchdog.tick();
    // The attempt is RELEASED now: no tick sees it again.
    expect(later.stalls.some((stall) => stall.kind === "candidate_pipeline_attempt")).toBe(false);
    waits.routeWatchdogStalls(later.stalls);
    expect(attemptNotices()).toHaveLength(1);
    expect(attemptNotices()[0]).toMatchObject({
      targetSessionId: ceo,
      payload: {
        resource: "attempt_crashed",
        owner: { role: run.ownerRoleKey, sessionId: run.ownerSessionId, generation: run.ownerBindingGeneration },
        effects: "MAY_HAVE_RUN",
        checkBeforeRerun: true,
        recoveryAction: expect.stringContaining("result_submit"),
        productFailure: false,
      },
    });

    harness.clock.advance(60_000);
    waits.routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    waits.routeWatchdogStalls([]);
    expect(attemptNotices()).toHaveLength(1);
  });

  it("H3-2: a reclaimed attempt still unresolved reaches a replacement CEO once after its notice was ACKed; once the run moved on, no later CEO is told", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    harness.cp.db.run(
      `INSERT INTO candidate_pipeline_attempts
         (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
       VALUES (?, 'attempt_crashed', ?, ?, NULL, 'RUNNING', ?, ?, NULL)`,
      [
        run.runId, run.ownerSessionId, run.ownerBindingGeneration,
        new Date(harness.clock.now().getTime() - 31 * 60 * 1000).toISOString(),
        new Date(harness.clock.now().getTime() - 60_000).toISOString(),
      ],
    );
    const attemptNotices = () => ceoNotices(harness, run.runId).filter((message) =>
      payloadOf(message)["notification"] === "CRITICAL_SYSTEM_FAILURE" && payloadOf(message)["stall"] === "candidate_pipeline_attempt");
    const routingPass = async (): Promise<void> => {
      waits.routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    };
    const acknowledge = (message: OutboxMessage | undefined): void => {
      const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(harness.cp.outbox.acknowledge(message!.messageId, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);
    };

    await routingPass();
    const [first] = attemptNotices();
    expect(attemptNotices()).toHaveLength(1);
    acknowledge(first);
    await routingPass();
    // An ACK is a receipt: the CEO that ACKed it is not told again.
    expect(attemptNotices()).toHaveLength(1);

    const replacement = recoverCeo(harness);
    for (let pass = 0; pass < 3; pass += 1) await routingPass();
    expect(attemptNotices()).toHaveLength(2);
    const second = attemptNotices().find((message) => message.messageId !== first!.messageId);
    expect(second).toMatchObject({ targetSessionId: replacement });
    expect(payloadOf(second)).toMatchObject({
      redelivery: true,
      correlation: payloadOf(first)["correlation"],
      episode: payloadOf(first)["episode"],
      resource: "attempt_crashed",
    });

    // The run's CTO moves the run on (its task graph): the stall cleared, and a CEO bound after that is told nothing.
    acknowledge(second);
    harness.clock.advance(60_000);
    expect(harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]).allowed).toBe(true);
    recoverCeo(harness);
    for (let pass = 0; pass < 3; pass += 1) await routingPass();
    expect(attemptNotices()).toHaveLength(2);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });

  it("H4-1: a reclaimed attempt's queued notice, settled by its run's progress, is handed to no replacement CEO; an incident its detector does not settle on progress stays open", async () => {
    const { IncidentClass, resolutionOf } = await import("../../src/ceo/ceo-incident-notices.ts");
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    insertAttempt(harness, run, { deadlineInMs: -60_000 });
    const attemptNotices = () => ceoNotices(harness, run.runId).filter((message) =>
      payloadOf(message)["notification"] === "CRITICAL_SYSTEM_FAILURE" && payloadOf(message)["stall"] === "candidate_pipeline_attempt");
    const routingPass = async (): Promise<void> => {
      waits.routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    };

    await routingPass();
    const [queued] = attemptNotices();
    expect(attemptNotices()).toEqual([expect.objectContaining({ status: "PENDING" })]);

    // The run's CTO moves the run on before the CEO takes the notice: the next pass settles the stall.
    harness.clock.advance(60_000);
    expect(harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]).allowed).toBe(true);
    await routingPass();
    expect(stallSettlements(harness, run.runId)).toEqual([expect.objectContaining({ target: "attempt_crashed", settled: "RUN_PROGRESSED" })]);

    const replacement = withBuzzRoute(harness, recoverCeo(harness));
    expect(harness.cp.outbox.claimDeliverable().filter((message) => message.runId === run.runId && message.kind === MessageKind.CEO_NOTIFICATION)).toEqual([]);
    expect(attemptNotices()).toEqual([expect.objectContaining({ messageId: queued!.messageId, status: "REJECTED" })]);
    expect(harness.cp.audit.forRun(run.runId).filter((entry) => entry.kind === "CEO_NOTIFICATION_WITHDRAWN")).toEqual([
      expect.objectContaining({ evidence: expect.objectContaining({ messageId: queued!.messageId, resolvedBy: "RUN_PROGRESSED" }) }),
    ]);

    // Later passes tell the replacement nothing of it.
    for (let pass = 0; pass < 3; pass += 1) await routingPass();
    expect(attemptNotices()).toHaveLength(1);
    expect(ceoNotices(harness, run.runId).filter((message) => message.targetSessionId === replacement)).toEqual([]);

    // The one definition of resolution says so for the incident whose detector settles on progress only: the
    // same run, correlation and episode stated by a detector that does not (an agent-owned wait's escalation,
    // pinned to the episode it opened in) is not closed by the run's progress.
    const episode = payloadOf(queued)["episode"] as string;
    const stated = { cls: IncidentClass.RUN_STALLED, subject: run.runId, runId: run.runId, episode, payload: {} };
    expect(resolutionOf(harness.cp.db, { ...stated, settlesOnProgress: true })).toMatchObject({ kind: "RUN_PROGRESSED" });
    expect(resolutionOf(harness.cp.db, stated)).toBeNull();
  });

  it("H4-2: a reclaimed attempt covered by its run's ACKed stall notice is settled by the run's progress, never told as a new episode", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    insertAttempt(harness, run, { deadlineInMs: 150 * 60 * 1000 });
    // The run's RUN_STALLED notices; its messages left undelivered in this fixture are a DELIVERY_STALLED of their own.
    const critical = () => ceoNotices(harness, run.runId).filter((message) => payloadOf(message)["incidentClass"] === "RUN_STALLED");
    const routingPass = async (): Promise<WatchdogTick> => {
      const tick = await harness.cp.watchdog.tick();
      waits.routeWatchdogStalls(tick.stalls);
      return tick;
    };

    // The run idles past its deadline: its RUN_STALLED notice, which the CEO ACKs.
    harness.clock.advance(121 * 60 * 1000);
    await routingPass();
    const [runStall] = critical();
    expect(critical()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ stall: "run" }) })]);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(harness.cp.outbox.acknowledge(runStall!.messageId, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);

    // The attempt passes its deadline in the same episode: reclaimed, and covered by the ACKed notice.
    harness.clock.advance(30 * 60 * 1000);
    const reclaiming = await routingPass();
    expect(reclaiming.stalls).toContainEqual(expect.objectContaining({ kind: "candidate_pipeline_attempt", id: "attempt_crashed" }));
    expect(critical()).toHaveLength(1);

    // The run's CTO moves the run on before the next pass.
    harness.clock.advance(60_000);
    expect(harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]).allowed).toBe(true);
    for (let pass = 0; pass < 3; pass += 1) await routingPass();
    expect(critical()).toEqual([expect.objectContaining({ messageId: runStall!.messageId })]);
    expect(stallSettlements(harness, run.runId)).toEqual([expect.objectContaining({ target: "attempt_crashed", settled: "RUN_PROGRESSED" })]);
  });

  it("with no CEO bound nothing is written, and the next pass routes it once the CEO is back", async () => {
    const harness = makeHarness();
    await activeRun(harness);
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
    const stuck = harness.cp.sessions.create({ provider: "scripted", model: "never-starts" });
    const waits = waitsOf(harness);
    harness.clock.advance(6 * 60 * 1000);
    const tick = await harness.cp.watchdog.tick();
    const sessionOnly = tick.stalls.filter((stall) => stall.id === stuck.sessionId);
    expect(waits.routeWatchdogStalls(sessionOnly)).toEqual([
      expect.objectContaining({ kind: "session", messageId: null, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED }),
    ]);
    expect(harness.cp.audit.byKind(OWNERLESS_STALL_ROUTED)).toEqual([]);
    bindCeo(harness);
    expect(waits.routeWatchdogStalls(sessionOnly)).toEqual([expect.objectContaining({ kind: "session", messageId: expect.any(String) })]);
  });
});
