import { afterAll, describe, expect, it } from "vitest";

import { AgentOwnedWaits, DEFAULT_AGENT_WAIT_DEADLINES } from "../../src/ceo/agent-owned-waits.ts";
import { CEO_NOTIFICATION_COVERED } from "../../src/ceo/ceo-incident-notices.ts";
import { ExecutionMode, Role, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { OutboxMessage } from "../../src/outbox/outbox.ts";
import { cleanupTempDirs, seedRun } from "../helpers/fixtures.ts";
import { type Harness, bindCeo, driveToReviewedCandidate, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A CEO notification never expires on its TTL (r-6b2239c63486). One whose exact request an official record
 * concluded is settled COVERED by the watchdog's sweep: out of the redelivery and watchdog-overdue sets, with its
 * attempts, outcome-unknown history and body kept, and the concluding record bound. Valid ones stay PENDING.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const waitsOf = (harness: Harness): AgentOwnedWaits =>
  new AgentOwnedWaits({
    db: harness.cp.db,
    clock: harness.cp.clock,
    audit: harness.cp.audit,
    runs: harness.cp.runs,
    bindings: harness.cp.bindings,
    outbox: harness.cp.outbox,
    artifacts: harness.cp.artifacts,
    gate: harness.cp.ceo,
  }, DEFAULT_AGENT_WAIT_DEADLINES);

const ceoSession = (harness: Harness): string => harness.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;

const ceoNotices = (harness: Harness): OutboxMessage[] =>
  harness.cp.db.all<{ message_id: string }>(`SELECT message_id FROM outbox WHERE kind = 'CEO_NOTIFICATION' ORDER BY created_at, rowid`)
    .map((row) => harness.cp.outbox.get(row.message_id)!);

const payloadOf = (message: OutboxMessage): Record<string, unknown> => message.payload as Record<string, unknown>;

const rowOf = (harness: Harness, messageId: string) =>
  harness.cp.db.get<Record<string, unknown>>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId])!;

/** The settlement records: CEO_NOTIFICATION_COVERED rows that name a concluding record. */
const settlements = (harness: Harness) =>
  harness.cp.audit.byKind(CEO_NOTIFICATION_COVERED).filter((entry) => entry.evidence["concludedBy"] !== undefined);

const historyOf = (harness: Harness, messageId: string) =>
  harness.cp.db.all(`SELECT * FROM audit_events WHERE json_extract(evidence_json, '$.messageId') = ? AND kind <> ?
    ORDER BY event_id`, [messageId, CEO_NOTIFICATION_COVERED]);

const outboxOverdue = (tick: { overdue: Array<{ kind: string; id: string }> }): string[] =>
  tick.overdue.filter((entry) => entry.kind === "outbox").map((entry) => entry.id);

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

describe("a CEO notice whose exact request an official record concluded is settled COVERED", () => {
  it("an escalation a CEO_DECISION resolved: COVERED and bound to that decision, history kept; another request on the run stays PENDING", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const open = (question: string, blocksCriticalPath: boolean): number => {
      const opened = harness.cp.ceo.openEscalation({
        runId: run.runId, question, options: ["a", "b"], ctoRecommendation: "a", whyItMatters: "the importer depends on it",
        blocksCriticalPath, openedBySessionId: run.ownerSessionId!, openedAt: harness.clock.nowIso(),
      });
      if (!opened.allowed || opened.value.escalationId === null) throw new Error(`escalation refused: ${opened.reasonCode}`);
      harness.clock.advance(1000);
      return opened.value.escalationId;
    };
    const noticeOf = (escalationId: number): OutboxMessage =>
      ceoNotices(harness).find((message) => payloadOf(message)["escalationId"] === escalationId)!;

    const resolved = open("which schema version does the importer target?", true);
    // Opened before the decision on `resolved`, and never decided itself: that decision concludes nothing here.
    const asideId = open("which log format does the importer write?", false);
    const resolvedNotice = noticeOf(resolved);
    // An outcome-unknown history: attempts made, the last one's outcome never confirmed, its journal kept.
    harness.cp.db.run(`UPDATE outbox SET attempts = 3, failure_class = 'unknown_observed',
      last_error = 'delivery unconfirmed, automatic resend held; awaiting its ACK' WHERE message_id = ?`, [resolvedNotice.messageId]);
    harness.cp.audit.record({ kind: "CEO_NOTIFICATION_CANONICAL_ATTEMPT", runId: run.runId,
      evidence: { messageId: resolvedNotice.messageId, attemptId: "attempt-1", receiver: "receiver-1" } });
    const before = rowOf(harness, resolvedNotice.messageId);
    const history = historyOf(harness, resolvedNotice.messageId);

    expect(harness.cp.ceo.resolveEscalation(run.runId, "v2", ceoSession(harness), { escalationId: resolved }))
      .toMatchObject({ allowed: true });
    const decision = harness.cp.audit.forRun(run.runId)
      .find((entry) => entry.kind === "CEO_DECISION" && entry.evidence["escalationId"] === resolved)!;
    harness.clock.advance(1000);
    const later = open("which encoding does the importer read?", true);
    harness.clock.advance(11 * MINUTE);

    const tick = await harness.cp.watchdog.tick();

    expect(rowOf(harness, resolvedNotice.messageId)).toEqual({ ...before, status: "REJECTED", reason_code: "CEO_NOTIFICATION_COVERED" });
    expect(historyOf(harness, resolvedNotice.messageId)).toEqual(history);
    expect(settlements(harness)).toHaveLength(1);
    expect(settlements(harness)[0]).toMatchObject({
      runId: run.runId,
      roleKey: "CEO",
      sessionId: resolvedNotice.targetSessionId,
      evidence: {
        messageId: resolvedNotice.messageId,
        status: "OUTCOME_UNKNOWN",
        automaticResendHeld: true,
        delivered: false,
        completed: false,
        attempts: 3,
        failureClass: "unknown_observed",
        request: { notification: "TRUE_ESCALATION", runId: run.runId, escalationId: resolved, incidentClass: "CTO_ESCALATION" },
        concludedBy: { kind: "CEO_DECISION", eventId: decision.eventId },
      },
    });
    for (const valid of [noticeOf(asideId), noticeOf(later)]) expect(rowOf(harness, valid.messageId)["status"]).toBe("PENDING");

    // Settled rows leave the watchdog-overdue set; valid ones stay in it.
    expect(outboxOverdue(tick)).not.toContain(resolvedNotice.messageId);
    expect(outboxOverdue(tick)).toEqual(expect.arrayContaining([noticeOf(asideId).messageId, noticeOf(later).messageId]));

    // Idempotent: a repeated sweep writes no second COVERED row and changes nothing.
    const settledRow = rowOf(harness, resolvedNotice.messageId);
    await harness.cp.watchdog.tick();
    expect(settlements(harness)).toHaveLength(1);
    expect(rowOf(harness, resolvedNotice.messageId)).toEqual(settledRow);

    // And the redelivery set: a recovered CEO is handed the valid notice, never the settled one.
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
    const recovered = bindCeo(harness);
    harness.cp.outbox.claimDeliverable();
    expect(rowOf(harness, noticeOf(later).messageId)).toMatchObject({ status: "PENDING", target_session_id: recovered });
    expect(rowOf(harness, resolvedNotice.messageId)).toEqual(settledRow);
  });

  it("a stall notice whose run is now CANCELLED: COVERED and bound to the cancel transition", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    harness.clock.advance(2 * HOUR + 1);
    waitsOf(harness).routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    const stall = ceoNotices(harness).find((message) => payloadOf(message)["incidentClass"] === "RUN_STALLED")!;
    expect(rowOf(harness, stall.messageId)["status"]).toBe("PENDING");
    await harness.cp.watchdog.tick();
    expect(rowOf(harness, stall.messageId)["status"]).toBe("PENDING");
    expect(settlements(harness)).toEqual([]);

    harness.clock.advance(1000);
    expect(harness.cp.runs.transition(run.runId, RunState.CANCELLED, "cancelled by the CEO").allowed).toBe(true);
    const cancel = harness.cp.audit.forRun(run.runId)
      .filter((entry) => entry.kind === "RUN_TRANSITION" && entry.evidence["to"] === RunState.CANCELLED).at(-1)!;
    harness.clock.advance(1000);
    await harness.cp.watchdog.tick();

    expect(rowOf(harness, stall.messageId)).toMatchObject({ status: "REJECTED", reason_code: "CEO_NOTIFICATION_COVERED" });
    expect(settlements(harness)).toEqual([expect.objectContaining({
      evidence: expect.objectContaining({
        messageId: stall.messageId,
        request: expect.objectContaining({ incidentClass: "RUN_STALLED", stall: "run", resource: run.runId }),
        concludedBy: { kind: "RUN_ENDED", eventId: cancel.eventId, runState: RunState.CANCELLED },
      }),
    })]);
  });

  it("a claim stall notice: COVERED by its claim's expiry once its episode is closed, PENDING while it is open", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const seeded = seedRun({ db: harness.cp.db, clock: harness.clock, repoPath: harness.repoPath });
    harness.clock.advance(HOUR + 1);
    waitsOf(harness).routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    const stall = ceoNotices(harness).find((message) => payloadOf(message)["stall"] === "claim")!;
    const claimId = payloadOf(stall)["resource"] as string;
    expect(harness.cp.claims.expireOverdue()).toBe(1);

    // The claim expired, but nothing has moved the run: the episode's notice still stands for it.
    harness.clock.advance(1000);
    await harness.cp.watchdog.tick();
    expect(rowOf(harness, stall.messageId)["status"]).toBe("PENDING");

    expect(harness.cp.runs.transition(seeded.runId, RunState.BLOCKED, "waiting on the claim's owner").allowed).toBe(true);
    harness.clock.advance(1000);
    await harness.cp.watchdog.tick();
    expect(rowOf(harness, stall.messageId)).toMatchObject({ status: "REJECTED", reason_code: "CEO_NOTIFICATION_COVERED" });
    expect(settlements(harness)).toEqual([expect.objectContaining({
      evidence: expect.objectContaining({ messageId: stall.messageId, concludedBy: { kind: "CLAIM_EXPIRED", eventId: null, claimId } }),
    })]);
  });

  it("a delivery stall notice: COVERED once its oldest stalled message is ACKed and none queued with it still waits", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const seeded = seedRun({ db: harness.cp.db, clock: harness.clock, repoPath: harness.repoPath, claim: false });
    const queue = (key: string): string => {
      const queued = harness.cp.outbox.enqueue({ idempotencyKey: key, roleKey: seeded.roleKey, bindingGeneration: 1,
        targetSessionId: seeded.sessionId, runId: seeded.runId, kind: MessageKind.TASK_ASSIGN, payload: { taskId: key } });
      if (!queued.allowed) throw new Error(queued.message);
      return queued.value.messageId;
    };
    const queuedTogether = [queue("first"), queue("second")];
    harness.clock.advance(11 * MINUTE);
    waitsOf(harness).routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    const stall = ceoNotices(harness).find((message) => payloadOf(message)["incidentClass"] === "DELIVERY_STALLED")!;
    const oldest = payloadOf(stall)["resource"] as string;
    expect(queuedTogether).toContain(oldest);
    const ack = (messageId: string) => expect(harness.cp.outbox.acknowledge(messageId, seeded.sessionId, 1, "inc-1").allowed).toBe(true);

    ack(oldest);
    await harness.cp.watchdog.tick();
    expect(rowOf(harness, stall.messageId)["status"]).toBe("PENDING");

    ack(queuedTogether.find((messageId) => messageId !== oldest)!);
    await harness.cp.watchdog.tick();
    expect(rowOf(harness, stall.messageId)).toMatchObject({ status: "REJECTED", reason_code: "CEO_NOTIFICATION_COVERED" });
    expect(settlements(harness)).toEqual([expect.objectContaining({
      evidence: expect.objectContaining({
        messageId: stall.messageId,
        concludedBy: { kind: "MESSAGE_ACKED", eventId: null, ackedMessageId: oldest, ackedAt: rowOf(harness, oldest)["acked_at"] },
      }),
    })]);
  });

  it("a review notice: COVERED by the CEO's CONFIRM of that candidate", async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness);
    await harness.cp.continuity.evaluate("test");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId, candidateSnapshotDigest: driven.candidateSnapshotDigest, resultSummary: "done", recommendation: "ship",
        residualRisk: [], approvedBySessionId: driven.ownerSessionId, approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
    const review = ceoNotices(harness).find((message) => payloadOf(message)["notification"] === "READY_FOR_CEO_REVIEW")!;
    await harness.cp.watchdog.tick();
    expect(rowOf(harness, review.messageId)["status"]).toBe("PENDING");

    harness.clock.advance(1000);
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId, decision: "CONFIRM", candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceoSession(harness), rationale: "ship it",
    });
    if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);
    const decision = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_DECISION").at(-1)!;
    await harness.cp.watchdog.tick();

    expect(rowOf(harness, review.messageId)).toMatchObject({ status: "REJECTED", reason_code: "CEO_NOTIFICATION_COVERED" });
    expect(settlements(harness)).toEqual([expect.objectContaining({
      evidence: expect.objectContaining({
        messageId: review.messageId,
        request: expect.objectContaining({ candidateSnapshotDigest: driven.candidateSnapshotDigest }),
        concludedBy: { kind: "CEO_DECISION", eventId: decision.eventId },
      }),
    })]);
  });
});
