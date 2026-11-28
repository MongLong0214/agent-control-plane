import { afterAll, describe, expect, it, vi } from "vitest";

import { AGENT_WAIT_DEADLINE, AgentOwnedWaits, DEFAULT_AGENT_WAIT_DEADLINES } from "../../src/ceo/agent-owned-waits.ts";
import { ExecutionMode, RunState } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { type Harness, bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1447 — a run continuity holds for a role it cannot cover is ended FAILED one deadline after its CEO_ESCALATION,
 * so the wait ends without a person (#1189). No other kind of wait ends a run.
 */
const HOUR = 60 * 60 * 1000;

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
  }, { ...DEFAULT_AGENT_WAIT_DEADLINES, escalationMs: HOUR, continuityHoldMs: HOUR });

const activeRun = async (harness: Harness) => {
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: "make app() return 2", why: "callers expect 2", scope: ["src/app.js"], nonGoals: [],
      acceptance: ["verify.js exits 0"], priority: "NORMAL", humanGate: [], references: [],
    },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return dispatched.value;
};

const heldRun = async (harness: Harness) => {
  const run = await activeRun(harness);
  expect(harness.cp.runs.pauseForContinuity(run.runId, run.ownerRoleKey!, "failover refused: SESSION_NOT_READY", {
    roleKey: run.ownerRoleKey, continuityAction: "PAUSE_NEW_WORK",
  })).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
  return run;
};

const ladder = ["RENOTIFY", "REASSIGN", "CEO_ESCALATION"];

describe("#1447 a continuity hold ends FAILED at its deadline", () => {
  it("after RENOTIFY, REASSIGN and CEO_ESCALATION plus one deadline, the held run is FAILED with the hold cleared and its evidence", async () => {
    const harness = makeHarness();
    const run = await heldRun(harness);
    const waits = waitsOf(harness);
    const recover = vi.fn();
    for (const step of ladder) {
      harness.clock.advance(HOUR);
      expect((await waits.sweep(recover)).taken).toEqual([expect.objectContaining({ kind: "CONTINUITY_HOLD", step })]);
      expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    }
    // Not before its deadline.
    harness.clock.advance(HOUR - 1);
    expect((await waits.sweep(recover)).taken).toEqual([]);
    harness.clock.advance(1);
    expect((await waits.sweep(recover)).taken).toEqual([expect.objectContaining({ kind: "CONTINUITY_HOLD", step: "FAIL" })]);
    expect(harness.cp.runs.require(run.runId)).toMatchObject({ state: RunState.FAILED, continuityHoldRoleKey: null });
    const failed = harness.cp.audit.forRun(run.runId).filter((entry) => entry.kind === "RUN_TRANSITION" && entry.evidence["to"] === RunState.FAILED);
    const markers = harness.cp.audit.forRun(run.runId).filter((entry) => entry.kind === AGENT_WAIT_DEADLINE);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.evidence).toMatchObject({
      from: RunState.BLOCKED, wait: "CONTINUITY_HOLD", episode: markers[0]!.evidence["episode"], heldRole: run.ownerRoleKey, steps: ladder,
    });
    expect(markers.map((entry) => entry.evidence["step"])).toEqual([...ladder, "FAIL"]);
    // A FAILED run is no wait: nothing more is taken.
    harness.clock.advance(10 * HOUR);
    expect(await waits.sweep(recover)).toEqual({ taken: [], deferred: [] });
  });

  it("an escalation wait never fails, however long it sits after its ladder", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const opened = harness.cp.ceo.openEscalation({
      runId: run.runId, question: "which schema version?", options: ["v1", "v2"], ctoRecommendation: "v2",
      whyItMatters: "the importer cannot target both", blocksCriticalPath: true,
      openedBySessionId: run.ownerSessionId!, openedAt: harness.clock.nowIso(),
    });
    expect(opened).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
    const waits = waitsOf(harness);
    for (let i = 0; i < 6; i++) {
      harness.clock.advance(HOUR);
      await waits.sweep(vi.fn());
    }
    expect(harness.cp.audit.forRun(run.runId).filter((entry) => entry.kind === AGENT_WAIT_DEADLINE).map((entry) => entry.evidence["step"])).toEqual(ladder);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
  });

  it("a hold released before its deadline is untouched", async () => {
    const harness = makeHarness();
    const run = await heldRun(harness);
    const waits = waitsOf(harness);
    for (const step of ladder) {
      harness.clock.advance(HOUR);
      expect((await waits.sweep(vi.fn())).taken).toEqual([expect.objectContaining({ step })]);
    }
    const released = harness.cp.runs.releaseContinuityHold(run.runId, harness.cp.bindings.active(run.ownerRoleKey!)!);
    expect(released).toMatchObject({ allowed: true, value: { released: true } });
    harness.clock.advance(10 * HOUR);
    expect((await waits.sweep(vi.fn())).taken).toEqual([]);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });
});
