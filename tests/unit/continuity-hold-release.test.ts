import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { deny } from "../../src/core/errors.ts";
import { WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import {
  ArtifactKind,
  ExecutionMode,
  Role,
  type RoleBinding,
  RunKind,
  RunState,
  SessionLifecycle,
  TaskState,
  roleKeyFor,
} from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { standardWorkContinuationTriggerKind } from "../../src/runtime/provisioned-session-runtime.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindWorkerForTask } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * S-HOLD — a CEO session restart pauses every ACTIVE run (`Daemon.pauseAffectedRuns`, continuity's own
 * BLOCKED hold, `continuity_hold_role_key` = CEO). Before this change only a bootstrap CTO's recovery and
 * the review-wait release ever left that hold, so once the CEO was re-adopted every STANDARD_WORK run
 * stayed BLOCKED for good: the live run_ab77268b (#512), "failover refused: SESSION_NOT_READY".
 *
 * The reconcile pass that finds the held role covered again releases the hold, BLOCKED → ACTIVE with one
 * RUN_TRANSITION, only when the hold is continuity's own, the owner pin is unchanged and still its
 * PRIMARY_CTO's READY binding, and nothing moved under it; it dispatches nothing, and the existing
 * STANDARD_WORK continuation wake (#1158) carries the run on. Every negative case is paired with a control
 * run released in the same pass, so none of them passes on a tree that releases nothing.
 *
 * Over the real sockets, driven PRIMARY_CTO and continuation wake; only the model is scripted.
 */

const CEO = roleKeyFor(Role.CEO);
const CHANGED = "the run's tasks, executions, artifacts or candidate attempts changed under the hold";
const RELEASE_REASON = `continuity hold released: ${CEO} covered again`;

const contract = {
  goal: "update the README",
  why: "one documentation change",
  scope: ["README.md"],
  nonGoals: [],
  acceptance: ["README.md documents the project"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: ["work branch: task/readme"],
};

let keys = 0;

/**
 * The driven PRIMARY_CTOs' model: a RUN_DISPATCH gets one PLAN with one docs task and is acknowledged,
 * and nothing else is done, so the run stops after its PLAN as run_ab77268b did. Prompts are recorded.
 */
const scriptOwners = (f: BootstrapRuntimeFixture): Map<string, string[]> => {
  const prompts = new Map<string, string[]>();
  const planned = new Set<string>();
  f.claude.onWorkTurn = async (request, credential) => {
    if (!credential || !prompts.has(credential.sessionId)) return;
    prompts.get(credential.sessionId)!.push(request.prompt);
    const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
    const call = (tool: string, args: Record<string, unknown>) => callMcpToolOverSocket(f.ctoSocket, as, tool, args);
    const pending = await call("role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; runId: string | null; kind: string }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      if (message.kind === MessageKind.RUN_DISPATCH && message.runId && !planned.has(message.runId)) {
        const submitted = await call("plan_submit", {
          idempotencyKey: `hold-${++keys}`,
          runId: message.runId,
          plan: { summary: "one README.md change by one worker" },
          tasks: [{ key: "readme", title: "update README.md", category: "docs", spec: {} }],
        });
        if (submitted["ok"] === true) planned.add(message.runId);
      }
      if (message.runId) {
        await call("run_ack", { idempotencyKey: `hold-${++keys}`, runId: message.runId, messageId: message.messageId });
      } else {
        await call("role_dispatch_ack", { messageId: message.messageId });
      }
    }
  };
  return prompts;
};

interface Project {
  projectId: string;
  sessionId: string;
  roleKey: string;
  prompts: string[];
}

const ownedProject = async (f: BootstrapRuntimeFixture, scripted: Map<string, string[]>, projectId: string): Promise<Project> => {
  const { binding } = await drivenPrimary(f, projectId);
  const prompts: string[] = [];
  scripted.set(binding.sessionId, prompts);
  return { projectId, sessionId: binding.sessionId, roleKey: binding.roleKey, prompts };
};

const idle = (f: BootstrapRuntimeFixture, sessionId: string) =>
  vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });

/** A STANDARD_WORK run dispatched to the project's driven owner, stopped after its PLAN: one READY task. */
const stalledRun = async (f: BootstrapRuntimeFixture, project: Project): Promise<string> => {
  const cp = f.harness.cp;
  const repository = cp.db.get<{ repository_id: string }>(`SELECT repository_id FROM repositories WHERE project_id = ?`, [project.projectId])!;
  const created = cp.runs.create({
    projectId: project.projectId,
    kind: RunKind.STANDARD_WORK,
    executionMode: ExecutionMode.SIMPLE,
    contract,
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turns = f.finishedTurns(project.sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  await f.awaitFinishedTurns(project.sessionId, turns + 1);
  await idle(f, project.sessionId);
  expect(cp.tasks.list(runId).map((task) => task.state)).toEqual([TaskState.READY]);
  expect(cp.outbox.listByRun(runId).find((row) => row.kind === MessageKind.RUN_DISPATCH)?.status).toBe("ACKED");
  expect(cp.runs.require(runId).state).toBe(RunState.ACTIVE);
  return runId;
};

/**
 * The CEO's Hermes session restarts: not READY, and the failover continuity tries is refused, as live.
 * Time has passed since the run's last write, as it had live (task 01:24Z, pause 04:09:28Z): the release
 * keeps the hold for anything of the run written in the pause's own millisecond.
 */
const loseCeo = async (f: BootstrapRuntimeFixture, options: { frozenClock?: boolean } = {}) => {
  const cp = f.harness.cp;
  // `frozenClock`: the clock does not move, so every write of the run shares the pause's millisecond.
  if (options.frozenClock !== true) f.harness.clock.advance(1_000);
  const ceo = cp.bindings.active(CEO)!;
  expect(cp.sessions.transition(ceo.sessionId, SessionLifecycle.ERROR, "the CEO's Hermes session restarted").allowed).toBe(true);
  const failover = vi.spyOn(cp.continuity, "failover")
    .mockResolvedValue(deny(ReasonCode.SESSION_NOT_READY, "the planned CEO session is not ready") as never);
  try {
    return (await f.daemon.reconcileContinuity("the CEO session restarted"))!;
  } finally {
    failover.mockRestore();
  }
};

/** The CEO re-adopted on a new READY session, at the next generation; the dead session is not revived. */
const readoptCeo = (f: BootstrapRuntimeFixture): RoleBinding => {
  const cp = f.harness.cp;
  const session = cp.sessions.create({ provider: "scripted", model: "c1b-ceo" });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "the CEO re-adopted").allowed).toBe(true);
  const bound = cp.bindings.bind({ role: Role.CEO, sessionId: session.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  return bound.value;
};

/** The run engine asked directly; a refusal (rather than a kept hold) fails the witness. */
const ask = (f: BootstrapRuntimeFixture, runId: string, binding: RoleBinding) => {
  const decided = f.harness.cp.runs.releaseContinuityHold(runId, binding);
  if (!decided.allowed) throw new Error(`${decided.reasonCode}: ${decided.message}`);
  return decided.value;
};

const reconcile = async (f: BootstrapRuntimeFixture, why: string) => (await f.daemon.reconcileContinuity(why))!;

const transitions = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.audit.forRun(runId).filter((entry) => entry.kind === "RUN_TRANSITION").map((entry) => entry.evidence);

const dispatches = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId).filter((row) => row.kind === MessageKind.RUN_DISPATCH).length;

const pin = (f: BootstrapRuntimeFixture, runId: string) => {
  const run = f.harness.cp.runs.require(runId);
  return {
    ownerRoleKey: run.ownerRoleKey,
    ownerSessionId: run.ownerSessionId,
    ownerSessionIncarnation: run.ownerSessionIncarnation,
    ownerBindingGeneration: run.ownerBindingGeneration,
  };
};

/** Continuity's own hold, as the CEO's loss leaves it. */
const expectHeld = (f: BootstrapRuntimeFixture, runId: string) => {
  const run = f.harness.cp.runs.require(runId);
  expect(run).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: CEO, stateReason: "failover refused: SESSION_NOT_READY" });
};

const expectReleased = (f: BootstrapRuntimeFixture, runId: string) => {
  const run = f.harness.cp.runs.require(runId);
  expect(run).toMatchObject({ state: RunState.ACTIVE, continuityHoldRoleKey: null, stateReason: RELEASE_REASON });
};

describe("S-HOLD witness 1 — the live counterexample: a CEO restart, then re-adoption, no longer strands a STANDARD_WORK run", () => {
  it("released to ACTIVE once on the unchanged owner pin, one RUN_TRANSITION, nothing dispatched, and the continuation carries it on; a second pass and a restarted daemon release nothing", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const project = await ownedProject(f, scripted, "hold-live");
      const runId = await stalledRun(f, project);
      const before = pin(f, runId);

      const lost = await loseCeo(f);
      expect(lost.pausedRuns).toContainEqual({ runId, roleKey: CEO, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
      expectHeld(f, runId);
      expect(cp.bindings.active(CEO)).toBeNull();
      // Held, nothing continues it.
      expect(f.daemon.wakeStandardWorkContinuation().woken).toEqual([]);
      const pausedAt = transitions(f, runId).length;
      const dispatched = dispatches(f, runId);

      const ceo = readoptCeo(f);
      expect(ceo.bindingGeneration).toBeGreaterThan(1);
      const restored = await reconcile(f, "the CEO is bound again");
      expectReleased(f, runId);
      expect(restored.continuityHolds.released).toEqual([runId]);
      expect(pin(f, runId)).toEqual(before);
      expect(pin(f, runId).ownerRoleKey).toBe(project.roleKey);
      const after = transitions(f, runId).slice(pausedAt);
      expect(after).toEqual([
        expect.objectContaining({
          from: RunState.BLOCKED,
          to: RunState.ACTIVE,
          reason: RELEASE_REASON,
          continuityRelease: CEO,
          toGeneration: ceo.bindingGeneration,
          ownerBindingGeneration: before.ownerBindingGeneration,
        }),
      ]);
      expect(dispatches(f, runId)).toBe(dispatched);
      const reconciled = cp.audit.byKind("CONTINUITY_RECONCILED").at(-1)!.evidence;
      expect(reconciled["continuityHolds"]).toMatchObject({ released: [runId] });

      // The existing continuation wake carries the run on, once, for the same owner.
      const task = cp.tasks.list(runId)[0]!;
      const turns = f.finishedTurns(project.sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toEqual([
        { runId, roleKey: project.roleKey, bindingGeneration: before.ownerBindingGeneration, taskId: task.taskId, taskState: TaskState.READY },
      ]);
      await f.awaitFinishedTurns(project.sessionId, turns + 1);
      await idle(f, project.sessionId);
      expect(project.prompts.at(-1)).toContain(standardWorkContinuationTriggerKind(runId, task.taskId));

      // Idempotent: a second pass, and a daemon that starts again, release nothing and write nothing.
      const settled = transitions(f, runId).length;
      expect((await reconcile(f, "a second pass")).continuityHolds.released).toEqual([]);
      const restarted = new Daemon(cp, { stateDir: tempDir("acp-hold-restart-") });
      expect((await restarted.reconcileContinuity("a restarted daemon"))!.continuityHolds.released).toEqual([]);
      expect(transitions(f, runId).length).toBe(settled);
      expect(dispatches(f, runId)).toBe(dispatched);
      expect(cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    });
  });
});

describe("S-HOLD witness 2 — not released while anything the hold depends on is not as it was", () => {
  it("the owner binding moved: kept, its pin untouched and never moved to the CEO", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const moved = await ownedProject(f, scripted, "hold-moved");
      const runId = await stalledRun(f, moved);
      await loseCeo(f);
      expectHeld(f, runId);
      const before = pin(f, runId);
      const pausedAt = transitions(f, runId).length;
      expect(cp.bindings.revoke(moved.roleKey, "the operator released the CTO", { allowBlockedRuns: true }).allowed).toBe(true);
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expect(pass.continuityHolds).toEqual({
        released: [],
        kept: expect.arrayContaining([{ runId, why: "the run's owner pin is not its PRIMARY_CTO's active binding" }]),
      });
      expectHeld(f, runId);
      expect(pin(f, runId)).toEqual(before);
      expect(transitions(f, runId).length).toBe(pausedAt);
    });
  });

  it("the owner session is not READY: kept; once it is READY again the next pass releases it", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const draining = await ownedProject(f, scripted, "hold-draining");
      const runId = await stalledRun(f, draining);
      await loseCeo(f);
      expect(cp.sessions.transition(draining.sessionId, SessionLifecycle.DRAINING, "test: the owner drains").allowed).toBe(true);
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectHeld(f, runId);
      expect(cp.sessions.transition(draining.sessionId, SessionLifecycle.READY, "test: the owner is back").allowed).toBe(true);
      const ready = await reconcile(f, "the owner is READY");
      expectReleased(f, runId);
      expect(pass.continuityHolds.released).toEqual([]);
      expect(pass.continuityHolds.kept).toContainEqual({ runId, why: "the run's owner session is not READY" });
      expect(ready.continuityHolds.released).toEqual([runId]);
    });
  });

  it("the held role is still uncovered: kept through every pass until the CEO is bound again", async () => {
    await withBootstrapRuntime(async (f) => {
      const scripted = scriptOwners(f);
      const project = await ownedProject(f, scripted, "hold-uncovered");
      const runId = await stalledRun(f, project);
      await loseCeo(f);
      const pausedAt = transitions(f, runId).length;
      const passes = [];
      for (const pass of ["a pass with no CEO", "another pass with no CEO"]) {
        passes.push(await reconcile(f, pass));
        expectHeld(f, runId);
      }
      expect(transitions(f, runId).length).toBe(pausedAt);
      readoptCeo(f);
      const covered = await reconcile(f, "the CEO is bound again");
      expectReleased(f, runId);
      expect(passes.map((pass) => pass.continuityHolds)).toEqual([{ released: [], kept: [] }, { released: [], kept: [] }]);
      expect(covered.continuityHolds.released).toEqual([runId]);
    });
  });

  it("a cancelled or failed run is never touched; the live one beside it is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const project = await ownedProject(f, scripted, "hold-terminal");
      const cancelled = await stalledRun(f, project);
      const failed = await stalledRun(f, project);
      const controlRun = await stalledRun(f, project);
      await loseCeo(f);
      expect(cp.runs.cancel(cancelled, "test: cancelled under the hold").allowed).toBe(true);
      expect(cp.runs.transition(failed, RunState.FAILED, "test: failed under the hold").allowed).toBe(true);
      const cancelledAt = transitions(f, cancelled).length;
      const failedAt = transitions(f, failed).length;
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, controlRun);
      expect(pass.continuityHolds.released).toEqual([controlRun]);
      expect(cp.runs.require(cancelled).state).toBe(RunState.CANCELLED);
      expect(cp.runs.require(failed).state).toBe(RunState.FAILED);
      expect(transitions(f, cancelled).length).toBe(cancelledAt);
      expect(transitions(f, failed).length).toBe(failedAt);
      // Asked directly, the engine answers the same.
      const ceo = cp.bindings.active(CEO)!;
      expect(ask(f, cancelled, ceo)).toMatchObject({ released: false, kept: "the run is CANCELLED, not BLOCKED" });
    });
  });

  it("its tasks moved under the hold: kept; the untouched run beside it is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const project = await ownedProject(f, scripted, "hold-tasks");
      const subjectRun = await stalledRun(f, project);
      const controlRun = await stalledRun(f, project);
      await loseCeo(f);
      expect(cp.tasks.submit(subjectRun, [{ key: "notes", title: "update the release notes", category: "docs" }]).allowed).toBe(true);
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, controlRun);
      expect(pass.continuityHolds.released).toEqual([controlRun]);
      expect(pass.continuityHolds.kept).toContainEqual({ runId: subjectRun, why: "TASK_GRAPH_SUBMITTED was recorded for the run after continuity's pause" });
      expectHeld(f, subjectRun);
    });
  });
});

describe("S-HOLD witness 3 — a BLOCKED run that is not continuity's own hold is never released", () => {
  it("a CEO decision hold, and a hold whose pause reason is not continuity's, stay BLOCKED; continuity's own beside them is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const project = await ownedProject(f, scripted, "hold-foreign");
      const decision = await stalledRun(f, project);
      const foreign = await stalledRun(f, project);
      const controlRun = await stalledRun(f, project);
      // Held for the CEO's decision before the CEO went away: no continuity hold at all.
      expect(cp.runs.transition(decision, RunState.BLOCKED, "CEO_DECISION_REQUIRED", { question: "which README?" }).allowed).toBe(true);
      // The hold column naming the CEO, through continuity's door, but for a reason continuity never pauses with.
      expect(cp.runs.pauseForContinuity(foreign, CEO, "CEO_DECISION_REQUIRED", { continuityAction: "PAUSE_NEW_WORK" }).allowed).toBe(true);
      await loseCeo(f);
      const decisionAt = transitions(f, decision).length;
      const foreignAt = transitions(f, foreign).length;
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, controlRun);
      expect(pass.continuityHolds.released).toEqual([controlRun]);
      expect(pass.continuityHolds.kept).toContainEqual({ runId: foreign, why: "no continuity pause is recorded since the run last entered ACTIVE" });
      expect(cp.runs.require(decision)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED", continuityHoldRoleKey: null });
      expect(cp.runs.require(foreign)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED", continuityHoldRoleKey: CEO });
      expect(transitions(f, decision).length).toBe(decisionAt);
      expect(transitions(f, foreign).length).toBe(foreignAt);
      const ceo = cp.bindings.active(CEO)!;
      expect(ask(f, decision, ceo)).toMatchObject({ released: false });
      expect(cp.runs.require(decision).state).toBe(RunState.BLOCKED);
    });
  });
});

describe("S-HOLD witness 4 — the release re-checks inside its own transaction", () => {
  it("a stale binding for the held role is refused, and so is a held role whose session is not READY; the current one releases", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const project = await ownedProject(f, scripted, "hold-stale");
      const runId = await stalledRun(f, project);
      await loseCeo(f);
      const stale = readoptCeo(f);
      expect(cp.bindings.revoke(CEO, "test: the CEO moved again", { allowBlockedRuns: true }).allowed).toBe(true);
      const current = readoptCeo(f);
      expect(current.bindingGeneration).toBeGreaterThan(stale.bindingGeneration);
      expect(ask(f, runId, stale))
        .toMatchObject({ released: false, kept: "the held role's binding is no longer its active one" });
      expect(cp.sessions.transition(current.sessionId, SessionLifecycle.DRAINING, "test: the CEO drains").allowed).toBe(true);
      expect(ask(f, runId, current))
        .toMatchObject({ released: false, kept: "the held role's session is not READY" });
      expectHeld(f, runId);
      expect(cp.sessions.transition(current.sessionId, SessionLifecycle.READY, "test: the CEO is back").allowed).toBe(true);
      expect(ask(f, runId, current)).toMatchObject({ released: true, kept: null });
      expectReleased(f, runId);
      expect(ask(f, runId, current)).toMatchObject({ released: false });
    });
  });

  it("a state change between the daemon's check and the release is refused: the run keeps the hold it is in now", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const scripted = scriptOwners(f);
      const project = await ownedProject(f, scripted, "hold-race");
      const subjectRun = await stalledRun(f, project);
      const controlRun = await stalledRun(f, project);
      await loseCeo(f);
      readoptCeo(f);
      // The pass reads the BLOCKED runs; the subject then moves — resumed and held again for a CEO
      // decision — before the run engine is asked to release it.
      const list = cp.runs.list.bind(cp.runs);
      let raced = false;
      vi.spyOn(cp.runs, "list").mockImplementation((filter = {}) => {
        const rows = list(filter);
        if (filter.state === RunState.BLOCKED && !raced) {
          raced = true;
          expect(cp.runs.transition(subjectRun, RunState.ACTIVE, "test: resumed elsewhere").allowed).toBe(true);
          expect(cp.runs.transition(subjectRun, RunState.BLOCKED, "CEO_DECISION_REQUIRED", { question: "which README?" }).allowed).toBe(true);
        }
        return rows;
      });
      const pass = await reconcile(f, "the CEO is bound again");
      expect(raced).toBe(true);
      expectReleased(f, controlRun);
      expect(pass.continuityHolds.released).toEqual([controlRun]);
      expect(pass.continuityHolds.kept).toContainEqual({ runId: subjectRun, why: "the run is not under continuity's hold for this role" });
      expect(cp.runs.require(subjectRun)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED", continuityHoldRoleKey: null });
    });
  });
});

/**
 * #1162 r1 — the reviewer's two blockers, ported (their unmodified probe file is replayed separately), and
 * a witness for each guard that closes them:
 *
 * - R1-01: the hold's episode is the EARLIEST continuity pause after the run last entered ACTIVE, and any
 *   audit record of the run after it keeps the hold; a copy of the pause appended through the ordinary
 *   AuditLog API can neither replace it nor hide what moved before it;
 * - R1-02: a write the audit log does not order (or orders only by an equal timestamp) keeps the hold
 *   when it lands at or after the pause's millisecond: the task write target `task_worker_run` prepares
 *   while the run is BLOCKED, a task row, an artifact.
 */
describe("#1162 r1 — the hold's baseline is the authentic pause, and every write after it keeps the hold", () => {
  it("R1-01 port: a copy of the pause appended after the run's tasks moved does not reset the baseline", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "port-forged-baseline");
      const runId = await stalledRun(f, project);
      await loseCeo(f);
      expectHeld(f, runId);
      const original = cp.audit.forRun(runId).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1)!;
      f.harness.clock.advance(10);
      expect(cp.tasks.submit(runId, [{ key: "extra", title: "extra work", category: "docs" }]).allowed).toBe(true);
      readoptCeo(f);
      expect(ask(f, runId, cp.bindings.active(CEO)!)).toMatchObject({ released: false });
      f.harness.clock.advance(10);
      expect(cp.audit.record({ kind: "RUN_TRANSITION", runId, evidence: original.evidence }).allowed).toBe(true);
      const pass = await reconcile(f, "probe: restored CEO after counterfeit pause");
      expectHeld(f, runId);
      expect(pass.continuityHolds.released).toEqual([]);
      expect(pass.continuityHolds.kept).toContainEqual({ runId, why: "TASK_GRAPH_SUBMITTED was recorded for the run after continuity's pause" });
    });
  });

  it("R1-02 port: the write target task_worker_run prepares while the run is BLOCKED, in the pause's millisecond, keeps the hold", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "port-target-moved");
      const runId = await stalledRun(f, project);
      await loseCeo(f);
      const task = cp.tasks.list(runId)[0]!;
      expect(task.spec).not.toHaveProperty("writeTarget");
      const tried = await f.cto(project.sessionId, "task_worker_run", {
        runId, taskId: task.taskId, claimId: "claim-does-not-matter-while-blocked",
      });
      expect(tried["ok"]).toBe(false);
      expect(tried["reasonCode"]).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
      const pause = cp.audit.forRun(runId).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1)!;
      expect(cp.tasks.require(task.taskId).updatedAt).toBe(pause.at);
      expect(cp.audit.forRun(runId).some((entry) => entry.kind === "TASK_WRITE_TARGET_RECORDED" && entry.eventId > pause.eventId)).toBe(true);
      expect(cp.tasks.require(task.taskId).spec).toHaveProperty("writeTarget");
      readoptCeo(f);
      const pass = await reconcile(f, "probe: task spec changed at same time");
      expectHeld(f, runId);
      expect(pass.continuityHolds.released).toEqual([]);
    });
  });

  it("a copy of the pause appended with nothing else moved still keeps the hold; the run beside it is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "forged-only");
      const subjectRun = await stalledRun(f, project);
      const controlRun = await stalledRun(f, project);
      await loseCeo(f);
      const original = cp.audit.forRun(subjectRun).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1)!;
      f.harness.clock.advance(10);
      expect(cp.audit.record({ kind: "RUN_TRANSITION", runId: subjectRun, evidence: original.evidence }).allowed).toBe(true);
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, controlRun);
      expectHeld(f, subjectRun);
      expect(pass.continuityHolds.released).toEqual([controlRun]);
      expect(pass.continuityHolds.kept).toContainEqual({ runId: subjectRun, why: "RUN_TRANSITION was recorded for the run after continuity's pause" });
    });
  });

  it("writes no audit record orders, in the pause's millisecond — a task row, an artifact — keep the hold; the run beside them is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "unaudited-writes");
      const taskRun = await stalledRun(f, project);
      const artifactRun = await stalledRun(f, project);
      const controlRun = await stalledRun(f, project);
      await loseCeo(f);
      const pausedAt = f.harness.clock.nowIso();
      const task = cp.tasks.list(taskRun)[0]!;
      cp.db.run(`UPDATE tasks SET spec_json = ?, updated_at = ? WHERE task_id = ?`, [
        JSON.stringify({ note: "changed under the hold" }), pausedAt, task.taskId,
      ]);
      cp.artifacts.put(artifactRun, ArtifactKind.PLAN, { summary: "a PLAN stored under the hold" });
      expect(cp.audit.forRun(taskRun).at(-1)!.kind).toBe("RUN_TRANSITION");
      expect(cp.audit.forRun(artifactRun).at(-1)!.kind).toBe("RUN_TRANSITION");
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, controlRun);
      expectHeld(f, taskRun);
      expectHeld(f, artifactRun);
      expect(pass.continuityHolds.released).toEqual([controlRun]);
      expect(pass.continuityHolds.kept).toEqual(expect.arrayContaining([
        { runId: taskRun, why: CHANGED },
        { runId: artifactRun, why: CHANGED },
      ]));
    });
  });

  it("a second episode: released, paused again by a second CEO loss, and released again from its own pause", async () => {
    await withBootstrapRuntime(async (f) => {
      const project = await ownedProject(f, scriptOwners(f), "second-episode");
      const runId = await stalledRun(f, project);
      const before = pin(f, runId);
      await loseCeo(f);
      readoptCeo(f);
      expect((await reconcile(f, "the CEO is bound again")).continuityHolds.released).toEqual([runId]);
      expectReleased(f, runId);
      const lost = await loseCeo(f);
      expect(lost.pausedRuns).toContainEqual({ runId, roleKey: CEO, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
      expectHeld(f, runId);
      readoptCeo(f);
      const again = await reconcile(f, "the CEO is bound once more");
      expectReleased(f, runId);
      expect(again.continuityHolds.released).toEqual([runId]);
      expect(pin(f, runId)).toEqual(before);
      expect(transitions(f, runId).filter((entry) => entry["reason"] === RELEASE_REASON)).toHaveLength(2);
    });
  });
});

/**
 * #1162 r2 (CEO 3b9d8289) — movement under the hold is told from record order precisely, under a frozen
 * clock as well:
 *
 * - R2-01: a refusal or a diagnostic recorded for the run (a repeated run_ack's OUTBOX_ACK_REJECTED) is
 *   not movement; only a run-mutating audit kind after the pause is;
 * - the pause records a digest of the run's tasks, executions, artifacts and candidate attempts, and the
 *   release compares it: an unchanged run is released though every row shares the pause's millisecond, and
 *   a real change is kept though no audit record orders it;
 * - a legacy pause, written before the digest existed (the live run_ab77268b's), falls back to the row
 *   times: none at or after the pause's time.
 *
 * R1-01's two-row forge through the in-process AuditLog.record is a stated Limit (CEO 3b9d8289, ruling A):
 * its probe is kept here as an expected failure, never as a pass.
 */
describe("#1162 r2 — refusals are not movement, and rows are compared by digest, not by clock", () => {
  it("R2-01 port: a repeated run_ack rejected over the CTO socket is not movement: the unchanged run is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "duplicate-ack");
      const subject = await stalledRun(f, project);
      const control = await stalledRun(f, project);
      await loseCeo(f);
      const before = {
        run: cp.runs.require(subject), tasks: cp.tasks.list(subject),
        artifacts: cp.db.all(`SELECT * FROM run_artifacts WHERE run_id = ?`, [subject]), outbox: cp.outbox.listByRun(subject),
      };
      const dispatch = before.outbox.find((row) => row.kind === MessageKind.RUN_DISPATCH)!;
      expect(dispatch.status).toBe("ACKED");
      const retried = await f.cto(project.sessionId, "run_ack", { runId: subject, messageId: dispatch.messageId });
      expect(retried["ok"]).toBe(false);
      expect(cp.audit.forRun(subject).at(-1)!.kind).toBe("OUTBOX_ACK_REJECTED");
      expect({
        run: cp.runs.require(subject), tasks: cp.tasks.list(subject),
        artifacts: cp.db.all(`SELECT * FROM run_artifacts WHERE run_id = ?`, [subject]), outbox: cp.outbox.listByRun(subject),
      }).toEqual(before);
      readoptCeo(f);
      const restored = await reconcile(f, "a rejected ACK did not move the run");
      expectReleased(f, control);
      expectReleased(f, subject);
      expect(restored.continuityHolds.released).toEqual(expect.arrayContaining([subject, control]));
    });
  });

  it("frozen clock, unchanged run: released, though its task and artifacts share the pause's millisecond", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "frozen-unchanged");
      const runId = await stalledRun(f, project);
      await loseCeo(f, { frozenClock: true });
      const pause = cp.audit.forRun(runId).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1)!;
      expect(cp.tasks.list(runId)[0]!.updatedAt).toBe(pause.at);
      expect(typeof pause.evidence["holdSnapshotDigest"]).toBe("string");
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, runId);
      expect(pass.continuityHolds.released).toEqual([runId]);
    });
  });

  it("frozen clock, real changes no audit record orders — a task, an artifact, an execution, a candidate attempt — are kept; the unchanged run beside them is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "frozen-changed");
      const taskRun = await stalledRun(f, project);
      const artifactRun = await stalledRun(f, project);
      const executionRun = await stalledRun(f, project);
      const attemptRun = await stalledRun(f, project);
      const controlRun = await stalledRun(f, project);
      // The execution run's task ran once, before the pause: an execution row the hold must keep unmoved.
      const executed = cp.tasks.list(executionRun)[0]!;
      const worker = bindWorkerForTask(cp, executed.taskId, { provider: "claude", model: "opus" });
      const opened = cp.tasks.startExecution({
        runId: executionRun, taskId: executed.taskId, ownerBindingGeneration: cp.runs.require(executionRun).ownerBindingGeneration!,
        workerSessionId: worker, provider: "claude", model: "opus",
      });
      if (!opened.allowed) throw new Error(opened.message);
      await loseCeo(f, { frozenClock: true });
      const now = f.harness.clock.nowIso();
      cp.db.run(`UPDATE tasks SET spec_json = ?, updated_at = ? WHERE task_id = ?`, [
        JSON.stringify({ note: "changed under the hold" }), now, cp.tasks.list(taskRun)[0]!.taskId,
      ]);
      cp.artifacts.put(artifactRun, ArtifactKind.PLAN, { summary: "a PLAN stored under the hold" });
      cp.db.run(`UPDATE task_executions SET last_activity_at = ? WHERE execution_id = ?`, [now, opened.value.executionId]);
      const owner = cp.runs.require(attemptRun);
      cp.db.run(
        `INSERT INTO candidate_pipeline_attempts
           (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
         VALUES (?, 'attempt-under-the-hold', ?, ?, NULL, 'RELEASED', ?, ?, ?)`,
        [attemptRun, owner.ownerSessionId, owner.ownerBindingGeneration, now, now, now],
      );
      for (const runId of [taskRun, artifactRun, executionRun, attemptRun]) {
        expect(cp.audit.forRun(runId).at(-1)!.kind).toBe("RUN_TRANSITION");
      }
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, controlRun);
      for (const runId of [taskRun, artifactRun, executionRun, attemptRun]) expectHeld(f, runId);
      expect(pass.continuityHolds.released).toEqual([controlRun]);
      expect(pass.continuityHolds.kept).toEqual(expect.arrayContaining(
        [taskRun, artifactRun, executionRun, attemptRun].map((runId) => ({ runId, why: CHANGED })),
      ));
    });
  });

  it("a legacy pause with no digest (the live run_ab77268b's shape) falls back to row times: released when nothing was written since, kept for a row of the pause's millisecond", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "legacy-pause");
      const quietRun = await stalledRun(f, project);
      const sameMsRun = await stalledRun(f, project);
      // The pause as the code before S-HOLD wrote it: the same transition, with no digest in its evidence.
      const record = cp.audit.record.bind(cp.audit);
      vi.spyOn(cp.audit, "record").mockImplementation((entry) => {
        if (entry.kind !== "RUN_TRANSITION" || entry.evidence?.["continuityAction"] !== "PAUSE_NEW_WORK") return record(entry);
        const { holdSnapshotDigest: _dropped, ...legacy } = entry.evidence;
        return record({ ...entry, evidence: legacy });
      });
      await loseCeo(f);
      vi.mocked(cp.audit.record).mockRestore();
      for (const runId of [quietRun, sameMsRun]) {
        const pause = cp.audit.forRun(runId).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1)!;
        expect(pause.evidence).not.toHaveProperty("holdSnapshotDigest");
      }
      cp.db.run(`UPDATE tasks SET updated_at = ? WHERE task_id = ?`, [f.harness.clock.nowIso(), cp.tasks.list(sameMsRun)[0]!.taskId]);
      readoptCeo(f);
      const pass = await reconcile(f, "the CEO is bound again");
      expectReleased(f, quietRun);
      expectHeld(f, sameMsRun);
      expect(pass.continuityHolds.released).toEqual([quietRun]);
      expect(pass.continuityHolds.kept).toContainEqual({ runId: sameMsRun, why: "a task of the run was written at or after continuity's pause" });
    });
  });

  it.fails("LIMIT R1-01 (CEO 3b9d8289, ruling A) — an in-process AuditLog.record forge of a return to ACTIVE and a copied pause still releases a changed run: expected to FAIL", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "forged-episode");
      const runId = await stalledRun(f, project);
      await loseCeo(f);
      const pause = cp.audit.forRun(runId).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1)!;
      f.harness.clock.advance(10);
      expect(cp.tasks.submit(runId, [{ key: "extra", title: "extra work", category: "docs" }]).allowed).toBe(true);
      readoptCeo(f);
      expect(ask(f, runId, cp.bindings.active(CEO)!)).toMatchObject({ released: false });
      f.harness.clock.advance(10);
      expect(cp.audit.record({ kind: "RUN_TRANSITION", runId, evidence: { from: RunState.BLOCKED, to: RunState.ACTIVE, reason: "forged" } }).allowed).toBe(true);
      expect(cp.audit.record({ kind: "RUN_TRANSITION", runId, evidence: { ...pause.evidence, holdSnapshotDigest: undefined } }).allowed).toBe(true);
      await reconcile(f, "the CEO is bound again after a forged episode");
      // What a closed R1-01 would hold; today the forge releases the run, so this assertion fails.
      expectHeld(f, runId);
    });
  });
});

/**
 * #1162 r3 — movement is classified by what a record says happened, not by its kind's name: a refusal or
 * an ignored input recorded for the run under the hold is not movement, though it shares a kind with an
 * applied change. The S-TB branch records are movement (their port is in continuity-hold-branch-movement).
 */
describe("#1162 r3 — a refused or ignored input recorded under the hold is not movement", () => {
  it("R2-01 port (late result): an old-generation execution result an authenticated owner submits over MCP is ignored, and the unchanged run is released", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "late-execution");
      const subject = await stalledRun(f, project);
      const control = await stalledRun(f, project);
      const task = cp.tasks.list(subject)[0]!;
      const worker = bindWorkerForTask(cp, task.taskId, { provider: "claude", model: "opus" });
      const execution = cp.tasks.startExecution({
        runId: subject, taskId: task.taskId, ownerBindingGeneration: cp.runs.require(subject).ownerBindingGeneration!,
        workerSessionId: worker, provider: "claude", model: "opus",
      });
      if (!execution.allowed) throw new Error(execution.message);
      const takeover = cp.bindings.switchTo({
        role: Role.PRIMARY_CTO, projectId: project.projectId, sessionId: project.sessionId,
        reason: "replacement before pause", conversation: "REPLACED", takeover: true,
      });
      expect(takeover, JSON.stringify(takeover)).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });
      expect(cp.tasks.execution(execution.value.executionId)?.status).toBe("ABANDONED");
      await loseCeo(f);
      const facts = () => ({
        run: cp.runs.require(subject), tasks: cp.tasks.list(subject), executions: cp.tasks.executions(subject),
        artifacts: cp.db.all(`SELECT * FROM run_artifacts WHERE run_id = ?`, [subject]),
        attempts: cp.db.all(`SELECT * FROM candidate_pipeline_attempts WHERE run_id = ?`, [subject]),
        outbox: cp.outbox.listByRun(subject),
      });
      const before = facts();
      const refused = await f.cto(project.sessionId, "task_receipt_submit", {
        runId: subject, taskId: task.taskId, phase: "finished", executionId: execution.value.executionId,
        workerSessionId: worker, status: "FAILED",
      });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
      expect(cp.audit.forRun(subject).at(-1)!.kind).toBe("TASK_EXECUTION_LATE_RESULT_IGNORED");
      expect(facts()).toEqual(before);
      readoptCeo(f);
      const report = await reconcile(f, "an ignored execution result is no movement");
      expectReleased(f, control);
      expectReleased(f, subject);
      expect(report.continuityHolds.released).toEqual(expect.arrayContaining([subject, control]));
    });
  });

  it("R2-01 port (guard): a managed write evaluation refused WRITE_RUN_NOT_ACTIVE is not movement; an allowed one would be", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "guard-refusal");
      const subject = await stalledRun(f, project);
      const control = await stalledRun(f, project);
      await loseCeo(f);
      const facts = () => ({
        run: cp.runs.require(subject), tasks: cp.tasks.list(subject), executions: cp.tasks.executions(subject),
        artifacts: cp.db.all(`SELECT * FROM run_artifacts WHERE run_id = ?`, [subject]), outbox: cp.outbox.listByRun(subject),
      });
      const before = facts();
      const owner = cp.runs.require(subject);
      const repo = cp.runs.repositoriesOf(subject)[0]!;
      const refused = cp.guard.evaluate({
        operation: WriteOperation.FILE_MUTATION, targetPath: `${repo.checkoutPath}/README.md`,
        repositoryIdentity: repo.identity, runId: subject, sessionId: owner.ownerSessionId!,
        sessionIncarnation: owner.ownerSessionIncarnation!, bindingGeneration: owner.ownerBindingGeneration!,
      });
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.WRITE_RUN_NOT_ACTIVE });
      const event = cp.audit.forRun(subject).at(-1)!;
      expect(event.kind).toBe("MANAGED_WRITE_GUARD");
      expect(event.evidence["allowed"]).toBe(false);
      expect(facts()).toEqual(before);
      readoptCeo(f);
      const report = await reconcile(f, "a denied write guard is no movement");
      expectReleased(f, control);
      expectReleased(f, subject);
      expect(report.continuityHolds.released).toEqual(expect.arrayContaining([subject, control]));
    });
  });

  it("a kind recorded with both outcomes is movement only when applied, or when its outcome cannot be read", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const project = await ownedProject(f, scriptOwners(f), "outcome-classified");
      const [stopFailed, stopped, guardAllowed, guardUnreadable] = [
        await stalledRun(f, project), await stalledRun(f, project), await stalledRun(f, project), await stalledRun(f, project),
      ];
      await loseCeo(f);
      // The records as their own writers word them, here written directly: the classification is the subject.
      cp.audit.record({ kind: "PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP", runId: stopFailed, reasonCode: ReasonCode.SESSION_STOP_FAILED, evidence: {} });
      cp.audit.record({ kind: "PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP", runId: stopped, reasonCode: ReasonCode.OK, evidence: {} });
      cp.audit.record({ kind: "MANAGED_WRITE_GUARD", runId: guardAllowed, reasonCode: ReasonCode.WRITE_ALLOWED, evidence: { allowed: true } });
      cp.audit.record({ kind: "MANAGED_WRITE_GUARD", runId: guardUnreadable, evidence: {} });
      readoptCeo(f);
      const report = await reconcile(f, "the CEO is bound again");
      expectReleased(f, stopFailed);
      for (const runId of [stopped, guardAllowed, guardUnreadable]) expectHeld(f, runId);
      expect(report.continuityHolds.kept).toEqual(expect.arrayContaining([
        { runId: stopped, why: "PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP was recorded for the run after continuity's pause" },
        { runId: guardAllowed, why: "MANAGED_WRITE_GUARD was recorded for the run after continuity's pause" },
        { runId: guardUnreadable, why: "MANAGED_WRITE_GUARD was recorded for the run after continuity's pause" },
      ]));
    });
  });
});
