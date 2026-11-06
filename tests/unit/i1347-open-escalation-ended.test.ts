import { afterAll, expect, it } from "vitest";

import { RunState } from "../../src/domain/types.ts";
import { cleanupTempDirs, seedRun } from "../helpers/fixtures.ts";
import { type Harness, bindCeo, makeHarness } from "../helpers/harness.ts";

/**
 * #1347 — a run's open escalation ends with the run: once the run is cancelled or failed (a RUN_TRANSITION after
 * the opening, to a terminal state), `openEscalationOf` answers null, the CEO incident path's RUN_ENDED rule
 * (`runEndedSince`), even when a CEO decision was recorded in between. A run
 * still live keeps it, and so does BLOCKED_POST_MERGE, which `openPostMergeResponsibility` still counts open.
 */

afterAll(cleanupTempDirs);

const auditRows = (h: Harness): number => h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events`)!.n;

const blockedByEscalation = (h: Harness) => {
  bindCeo(h);
  const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
  const opened = h.cp.ceo.openEscalation({
    runId: run.runId,
    question: "which repository?",
    options: ["one", "two"],
    ctoRecommendation: "one",
    whyItMatters: "repository identity",
    blocksCriticalPath: true,
    openedBySessionId: run.sessionId,
    openedAt: h.clock.nowIso(),
  });
  if (!opened.allowed) throw new Error(opened.message);
  expect(h.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
  return { runId: run.runId, escalationId: opened.value.escalationId! };
};

it("a cancelled run's escalation is no longer open, and asking records nothing", () => {
  const h = makeHarness();
  try {
    const { runId, escalationId } = blockedByEscalation(h);
    expect(h.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId });
    expect(h.cp.runs.cancel(runId, "withdrawn").allowed).toBe(true);
    const before = auditRows(h);
    expect(h.cp.ceo.openEscalationOf(runId)).toBeNull();
    expect(auditRows(h)).toBe(before);
    expect(h.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND kind = 'CEO_DECISION'`, [runId],
    )!.n).toBe(0);
  } finally {
    h.cp.close();
  }
});

// The run's end is asked on its own: a CEO decision recorded between the opening and the end, which the CEO
// incident path ranks first, does not keep the escalation open.
it.each([RunState.CANCELLED, RunState.FAILED])("a CEO decision before the run is %s does not hide its end", (end) => {
  const h = makeHarness();
  try {
    const { runId, escalationId } = blockedByEscalation(h);
    for (const to of [RunState.ACTIVE, RunState.READY_FOR_CEO_REVIEW]) {
      expect(h.cp.runs.transition(runId, to, "fixture")).toMatchObject({ allowed: true });
    }
    const decided = h.cp.audit.record({
      kind: "CEO_DECISION",
      runId,
      evidence: { decision: "OWNER_DECISION_REQUIRED", ownerReason: "DIRECTION_CHANGE_OUTSIDE_CONTRACT", blockedAction: "merge" },
    });
    expect(decided).toMatchObject({ allowed: true });
    expect(h.cp.runs.transition(runId, RunState.AWAITING_HUMAN, "OWNER_DECISION_REQUIRED")).toMatchObject({ allowed: true });
    expect(h.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId });
    const ended = end === RunState.CANCELLED ? h.cp.runs.cancel(runId, "withdrawn") : h.cp.runs.transition(runId, end, "fixture");
    expect(ended, JSON.stringify(ended)).toMatchObject({ allowed: true });
    expect(h.cp.ceo.openEscalationOf(runId)).toBeNull();
  } finally {
    h.cp.close();
  }
});

it("a run still live keeps its open escalation", () => {
  const h = makeHarness();
  try {
    const { runId, escalationId } = blockedByEscalation(h);
    h.clock.advance(60_000);
    expect(h.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId });
  } finally {
    h.cp.close();
  }
});

it("a BLOCKED_POST_MERGE run keeps its open escalation", () => {
  const h = makeHarness();
  try {
    const { runId, escalationId } = blockedByEscalation(h);
    for (const to of [RunState.ACTIVE, RunState.READY_FOR_CEO_REVIEW, RunState.CEO_APPROVED, RunState.MERGING, RunState.BLOCKED_POST_MERGE]) {
      const moved = h.cp.runs.transition(runId, to, "fixture");
      expect(moved, JSON.stringify(moved)).toMatchObject({ allowed: true });
    }
    expect(h.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId });
  } finally {
    h.cp.close();
  }
});
