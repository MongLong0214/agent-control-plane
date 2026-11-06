import { afterAll, describe, expect, it, vi } from "vitest";

import { AgentOwnedWaits } from "../../src/ceo/agent-owned-waits.ts";
import { OWNERLESS_STALL_ROUTED, type WatchdogTick } from "../../src/doctor/watchdog.ts";
import { ExecutionMode, Role, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { type Harness, bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1361 — a stall notice is never issued for a run that has ended (COMPLETED, FAILED, CANCELLED), and the
 * transition that ended it is never read as the start of a new stall episode. Live: the watchdog observed an
 * ACTIVE run stalled, the CEO cancelled it, and the routing of that tick, 12.7 s later, issued a new notice whose
 * episode was the cancel itself. The run's state is asked in the transaction that would write the notice.
 */

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
  });

const dispatchRun = async (harness: Harness, project: { projectId: string; repositoryId: string }) => {
  const created = harness.cp.runs.create({
    projectId: project.projectId,
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
    repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  return dispatched.value;
};

/** An ACTIVE run of a registered project, with a CEO bound. */
const activeRun = async (harness: Harness) => {
  const project = await registerFixtureProject(harness);
  bindCeo(harness);
  return dispatchRun(harness, project);
};

const runStalls = (tick: WatchdogTick) => tick.stalls.filter((stall) => stall.kind === "run");

const stallNotices = (harness: Harness, runId: string) =>
  harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.CEO_NOTIFICATION
    && (message.payload as Record<string, unknown>)["notification"] === "CRITICAL_SYSTEM_FAILURE");

const routedRecords = (harness: Harness, runId: string) =>
  harness.cp.audit.forRun(runId).filter((entry) => entry.kind === OWNERLESS_STALL_ROUTED);

const RUN_PROGRESS_DEADLINE_PASSED = 121 * 60 * 1000;
const OUTBOX_DEADLINE_PASSED = 11 * 60 * 1000;

describe("#1361 — a stall notice is never issued for a run that has ended", () => {
  it("the live sequence: a stalled ACTIVE run is told once; the CEO cancels it; the tick that observed it ACTIVE, routed after the cancel, and every later tick issue nothing", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);

    harness.clock.advance(RUN_PROGRESS_DEADLINE_PASSED);
    const first = runStalls(await harness.cp.watchdog.tick());
    expect(first).toEqual([expect.objectContaining({ id: run.runId, runId: run.runId })]);
    waits.routeWatchdogStalls(first);
    expect(stallNotices(harness, run.runId)).toHaveLength(1);
    expect(routedRecords(harness, run.runId)).toHaveLength(1);

    // The next tick observes the run still ACTIVE and stalled; the CEO's cancel lands before its routing runs.
    harness.clock.advance(60_000);
    const observed = runStalls(await harness.cp.watchdog.tick());
    expect(observed).toEqual([expect.objectContaining({ id: run.runId, since: first[0]!.since })]);
    harness.clock.advance(12_700);
    expect(harness.cp.runs.cancel(run.runId, "the CEO cancels the run").allowed).toBe(true);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.CANCELLED);

    waits.routeWatchdogStalls(observed);
    expect(stallNotices(harness, run.runId)).toHaveLength(1);
    expect(routedRecords(harness, run.runId)).toHaveLength(1);

    // Nor is the end grounds for a re-notice: not on a later tick, nor to a CEO that replaced the one told.
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
    bindCeo(harness);
    harness.clock.advance(RUN_PROGRESS_DEADLINE_PASSED);
    waits.routeWatchdogStalls(observed);
    waits.routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    expect(stallNotices(harness, run.runId)).toHaveLength(1);
    expect(routedRecords(harness, run.runId)).toHaveLength(1);
  });

  it("the run's state is asked in the transaction that writes the notice: a cancel committed just before it opens leaves nothing issued", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    harness.clock.advance(RUN_PROGRESS_DEADLINE_PASSED);
    const observed = runStalls(await harness.cp.watchdog.tick());
    expect(observed).toEqual([expect.objectContaining({ id: run.runId })]);

    // Another writer's cancel commits between every read made before the routing's transaction and that transaction.
    const db = harness.cp.db;
    const begin = db.txDecision.bind(db);
    const raced = vi.spyOn(db, "txDecision").mockImplementationOnce((fn) => {
      expect(harness.cp.runs.cancel(run.runId, "the CEO cancels the run").allowed).toBe(true);
      return begin(fn);
    });
    waits.routeWatchdogStalls(observed);
    raced.mockRestore();

    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.CANCELLED);
    expect(stallNotices(harness, run.runId)).toEqual([]);
    expect(routedRecords(harness, run.runId)).toEqual([]);
  });

  it("a delivery stall of a message for a run that has ended is told nothing: the cancelled run's undelivered RUN_DISPATCH raises no DELIVERY_STALLED, asked in the transaction that would write it", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    const dispatch = harness.cp.outbox.listByRun(run.runId).find((message) => message.kind === MessageKind.RUN_DISPATCH);
    expect(dispatch?.status).toBe("PENDING");

    harness.clock.advance(OUTBOX_DEADLINE_PASSED);
    const observed = (await harness.cp.watchdog.tick()).stalls.filter((stall) => stall.kind === "outbox");
    expect(observed).toEqual([expect.objectContaining({ id: dispatch!.messageId, runId: run.runId })]);
    // The CEO's cancel commits after every read the routing makes before its transaction opens.
    const db = harness.cp.db;
    const begin = db.txDecision.bind(db);
    const raced = vi.spyOn(db, "txDecision").mockImplementationOnce((fn) => {
      expect(harness.cp.runs.cancel(run.runId, "the CEO cancels the run").allowed).toBe(true);
      return begin(fn);
    });
    expect(waits.routeWatchdogStalls(observed)).toEqual([expect.objectContaining({ kind: "outbox", messageId: null })]);
    raced.mockRestore();
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.CANCELLED);
    expect(harness.cp.outbox.get(dispatch!.messageId)?.status).toBe("PENDING");

    harness.clock.advance(OUTBOX_DEADLINE_PASSED);
    waits.routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);
    expect(stallNotices(harness, run.runId)).toEqual([]);
    expect(routedRecords(harness, run.runId)).toEqual([]);
  });

  it("a role's stalled messages for a run that has ended and for a live run: the live run's is told, filed under it, and nothing is filed under the ended run", async () => {
    const harness = makeHarness();
    const project = await registerFixtureProject(harness);
    bindCeo(harness);
    const ended = await dispatchRun(harness, project);
    harness.clock.advance(60_000);
    const live = await dispatchRun(harness, project);
    harness.clock.advance(OUTBOX_DEADLINE_PASSED);
    expect(harness.cp.runs.cancel(ended.runId, "the CEO cancels the run").allowed).toBe(true);

    const observed = (await harness.cp.watchdog.tick()).stalls.filter((stall) => stall.kind === "outbox");
    expect(observed.map((stall) => stall.runId).sort()).toEqual([ended.runId, live.runId].sort());
    expect(new Set(observed.map((stall) => stall.roleKey)).size).toBe(1);
    waitsOf(harness).routeWatchdogStalls(observed);

    expect(stallNotices(harness, ended.runId)).toEqual([]);
    expect(routedRecords(harness, ended.runId)).toEqual([]);
    expect(stallNotices(harness, live.runId)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ incidentClass: "DELIVERY_STALLED", runId: live.runId }) }),
    ]);
  });

  it("a delivery stall of a message for a live run still notifies, once", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    harness.clock.advance(OUTBOX_DEADLINE_PASSED);
    const observed = (await harness.cp.watchdog.tick()).stalls.filter((stall) => stall.kind === "outbox");
    expect(observed).toEqual([expect.objectContaining({ runId: run.runId, messageKind: MessageKind.RUN_DISPATCH })]);
    expect(waits.routeWatchdogStalls(observed)).toEqual([expect.objectContaining({ kind: "outbox", messageId: expect.any(String) })]);
    waits.routeWatchdogStalls(observed);
    expect(stallNotices(harness, run.runId)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ incidentClass: "DELIVERY_STALLED", stall: "outbox", runId: run.runId }) }),
    ]);
    expect(routedRecords(harness, run.runId)).toHaveLength(1);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });

  it("a genuinely stalled ACTIVE run still gets its notice, once", async () => {
    const harness = makeHarness();
    const run = await activeRun(harness);
    const waits = waitsOf(harness);
    harness.clock.advance(RUN_PROGRESS_DEADLINE_PASSED);
    const routed = waits.routeWatchdogStalls(runStalls(await harness.cp.watchdog.tick()));
    expect(routed).toEqual([expect.objectContaining({ kind: "run", id: run.runId, messageId: expect.any(String) })]);
    expect(stallNotices(harness, run.runId)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ stall: "run", resource: run.runId, runId: run.runId }) }),
    ]);
    expect(routedRecords(harness, run.runId)).toHaveLength(1);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });
});
