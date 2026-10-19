import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import {
  ContinuityMode,
  ExecutionMode,
  Role,
  RunKind,
  RunState,
  SessionLifecycle,
  TaskState,
  roleKeyFor,
} from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { WorkerExecutionView } from "../../src/run/worker-turn.ts";
import {
  STANDARD_WORK_CONTINUATION_STALLED,
  STANDARD_WORK_CONTINUATION_WAKE,
  standardWorkContinuationTriggerId,
  standardWorkContinuationTriggerKind,
} from "../../src/runtime/provisioned-session-runtime.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindWorkerForTask } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #512 — a driven PRIMARY_CTO carries a STANDARD_WORK run past its PLAN (CEO f5ce5dbf):
 *
 * - its work prompt tells it, for a run whose contract_get returned no bootstrapPlanGuide, to staff,
 *   claim, run and read each READY task and then submit the result, before it acknowledges the
 *   RUN_DISPATCH; a BOOTSTRAP_CTO's prompt is unchanged;
 * - a run stopped after its PLAN (task READY, no worker, owner idle, RUN_DISPATCH acknowledged) is
 *   woken once by the daemon's standard work continuation, for the same owner; a second pass wakes
 *   nothing, and a woken turn that made no progress leaves one explicit blocker and nothing more;
 * - a task already staffed, running or executed, an owner turn running or queued, a stale or absent
 *   owner, a holder this runtime does not drive or hold, a run under review, CEO wait, hold, or
 *   cancelled, is never woken.
 *
 * Over the real sockets, launch channel and in-band wake; only the model is scripted, and its work
 * turn does what its prompt says. Where a row needs a worker to run, the control plane's worker
 * runtime is stood in for by real task records (a WORKER binding, an execution and its receipt).
 */

const CONTRACT = {
  goal: "update the README",
  why: "one documentation change",
  scope: ["README.md"],
  nonGoals: [],
  acceptance: ["README.md documents the project"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const STANDARD_DIRECTIVE = "For a run whose contract_get returned no bootstrapPlanGuide";
const CONTINUATION_LINE = 'A wake for "standard work continuation: run <runId> has READY task <taskId> with no worker"';
const CONTINUATION_KIND = /standard work continuation: run (\S+) has READY task (\S+) with no worker/;

/** One counter for every owner: an MCP idempotency key is reserved for whichever peer used it first. */
let keys = 0;

interface StandardOwner {
  /** Every work turn's prompt, in order. */
  readonly prompts: string[];
  /** Every tool the owner called for a run, in order, with whether it was accepted. */
  readonly calls: Array<{ tool: string; runId: string; taskId: string | null; ok: boolean; reasonCode: string | null }>;
  /** Holds every work turn at its start until the returned release is called. */
  hold(): () => void;
}

/**
 * A scripted stand-in for the driven PRIMARY_CTO's model, acting only through the acp-cto tools with
 * the credential its relay took for the turn, and doing only what its prompt says:
 *
 * - a RUN_DISPATCH it holds no PLAN for: `contract_get`, then one `plan_submit` with one docs task;
 * - `onDispatch: "follow-prompt"` then carries the run past its PLAN when, and only when, the prompt
 *   carries the directive for a run with no bootstrapPlanGuide; `"plan-only"` does not (the stall
 *   observed live on run_ab77268b); `"plan-no-ack"` does not either, and leaves the RUN_DISPATCH
 *   unacknowledged;
 * - `onContinuation: "follow-prompt"` carries the run a continuation wake names when the prompt
 *   carries that wake's line; `"ignore"` answers such a wake with no tool call at all;
 * - every row it read is acknowledged with `run_ack` last.
 *
 * Carrying a run means what the directive says: for each READY task, read what this conversation
 * already started for it, otherwise staff it with the provider the directive names, claim, run, read
 * the execution until it settles; then submit the result.
 */
const scriptStandardOwner = (
  f: BootstrapRuntimeFixture,
  sessionId: string,
  options: { onDispatch: "follow-prompt" | "plan-only" | "plan-no-ack"; onContinuation: "follow-prompt" | "ignore" },
): StandardOwner => {
  let gate: Promise<void> | null = null;
  /** What the owner's own conversation holds: per run, the tasks plan_submit answered; per task, what it started. */
  const planned = new Map<string, string[]>();
  const repositories = new Map<string, { identity: string; checkoutPath: string }>();
  const started = new Map<string, { workerSessionId?: string; executionId?: string }>();
  const owner: StandardOwner = {
    prompts: [],
    calls: [],
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
  f.claude.onWorkTurn = async (request, credential) => {
    // The project's bootstrap run's BOOTSTRAP_CTO shares this double; only the PRIMARY_CTO acts here.
    if (!credential || credential.sessionId !== sessionId) return;
    owner.prompts.push(request.prompt);
    if (gate) await gate;
    const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
    const call = async (tool: string, runId: string, taskId: string | null, args: Record<string, unknown>) => {
      const answer = await callMcpToolOverSocket(f.ctoSocket, as, tool, args);
      owner.calls.push({
        tool,
        runId,
        taskId,
        ok: answer["ok"] === true,
        reasonCode: typeof answer["reasonCode"] === "string" ? answer["reasonCode"] : null,
      });
      return answer;
    };
    const lines = request.prompt.split("\n");
    const directive = lines.find((line) => line.startsWith(STANDARD_DIRECTIVE)) ?? null;
    const provider = directive === null ? null : /provider "([^"]+)"/.exec(directive)?.[1] ?? null;

    /** The directive's steps for one run, from what this conversation knows about it. */
    const carry = async (runId: string, taskIds: readonly string[]): Promise<void> => {
      if (directive === null || provider === null) return;
      for (const taskId of taskIds) {
        const mine = started.get(taskId) ?? {};
        started.set(taskId, mine);
        if (mine.executionId === undefined) {
          if (mine.workerSessionId === undefined) {
            const provisioned = await call("task_worker_provision", runId, taskId, {
              idempotencyKey: `std-owner-${++keys}`, runId, taskId, provider,
            });
            if (provisioned["ok"] !== true) return;
            mine.workerSessionId = (provisioned["value"] as { workerSessionId: string }).workerSessionId;
          }
          // The repository the directive says to claim, from what contract_get returned for the run.
          const repository = repositories.get(runId);
          if (!repository) return;
          const claimed = await call("resource_claim", runId, taskId, {
            idempotencyKey: `std-owner-${++keys}`, runId, repositoryIdentity: repository.identity,
            branch: `acp/${taskId}`, worktreeId: repository.checkoutPath, declaredPaths: ["README.md"],
          });
          if (claimed["ok"] !== true) return;
          const claimId = (claimed["value"] as { claims: Array<{ claimId: string }> }).claims[0]!.claimId;
          const ran = await call("task_worker_run", runId, taskId, { idempotencyKey: `std-owner-${++keys}`, runId, taskId, claimId });
          if (ran["ok"] !== true) return;
          mine.executionId = (ran["value"] as { executionId: string }).executionId;
        }
        let status = "RUNNING";
        while (status === "RUNNING") {
          const read = await call("task_execution_get", runId, taskId, { runId, executionId: mine.executionId });
          if (read["ok"] !== true) return;
          status = (read["value"] as { execution: { status: string } }).execution.status;
        }
        if (status !== "SUCCEEDED") {
          await call("escalation_open", runId, taskId, {
            idempotencyKey: `std-owner-${++keys}`, runId, question: "the task's execution did not succeed",
            options: ["investigate"], ctoRecommendation: "investigate", whyItMatters: "the run cannot complete", blocksCriticalPath: true,
          });
          return;
        }
      }
      await call("result_submit", runId, null, {
        idempotencyKey: `std-owner-${++keys}`, runId, resultSummary: "README.md updated", recommendation: "merge",
      });
    };

    const readContract = async (runId: string): Promise<Record<string, unknown> | undefined> => {
      const contract = (await call("contract_get", runId, null, { runId }))["value"] as Record<string, unknown> | undefined;
      const repository = (contract?.["repositories"] as Array<{ identity: string; checkoutPath: string }> | undefined)?.[0];
      if (repository) repositories.set(runId, repository);
      return contract;
    };

    const woke = CONTINUATION_KIND.exec(lines.find((line) => line.startsWith("The control plane woke you for:")) ?? "");
    if (woke && options.onContinuation === "follow-prompt" && lines.some((line) => line.startsWith(CONTINUATION_LINE))) {
      const [, runId, taskId] = woke;
      if (!repositories.has(runId!)) await readContract(runId!);
      await carry(runId!, planned.get(runId!) ?? [taskId!]);
    }

    const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; runId: string | null; kind: string }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      if (message.kind === MessageKind.RUN_DISPATCH && message.runId && !planned.has(message.runId)) {
        const runId = message.runId;
        const contract = await readContract(runId);
        const guided = Boolean(contract?.["bootstrapPlanGuide"]);
        const submitted = await call("plan_submit", runId, null, {
          idempotencyKey: `std-owner-${++keys}`,
          runId,
          plan: { summary: "one README.md change by one worker" },
          tasks: [{ key: "readme", title: "update README.md", category: "docs" }],
        });
        if (submitted["ok"] === true) {
          planned.set(runId, (submitted["value"] as Array<{ taskId: string }>).map((task) => task.taskId));
          if (!guided && options.onDispatch === "follow-prompt") await carry(runId, planned.get(runId)!);
        }
      }
      if (message.runId && options.onDispatch === "plan-no-ack") continue;
      if (message.runId) {
        await call("run_ack", message.runId, null, { idempotencyKey: `std-owner-${++keys}`, runId: message.runId, messageId: message.messageId });
      } else {
        await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId });
      }
    }
  };
  return owner;
};

/**
 * The control plane's worker runtime, stood in for by the records it leaves: provisioning binds the
 * task's WORKER on a Claude Opus session; a worker turn opens its execution and closes it SUCCEEDED;
 * the execution is read back from its record; a result submission is answered without a pipeline.
 * The tools themselves, their owner fence and their sockets are real.
 */
const standInWorkerRuntime = (f: BootstrapRuntimeFixture) => {
  const cp = f.harness.cp;
  const provision = vi.spyOn(cp.workers, "provision").mockImplementation(async (request) => {
    const workerSessionId = bindWorkerForTask(cp, request.taskId, { provider: "claude", model: "opus" });
    return allow(ReasonCode.OK, { workerSessionId, generation: 1 });
  });
  const start = vi.spyOn(cp.workerTurns, "start").mockImplementation(async (request) => {
    const worker = cp.bindings.active(roleKeyFor(Role.WORKER, { taskId: request.taskId }));
    if (!worker) throw new Error("the stand-in worker turn found no WORKER binding");
    const opened = cp.tasks.startExecution({
      runId: request.runId,
      taskId: request.taskId,
      ownerBindingGeneration: request.ownerBindingGeneration,
      workerSessionId: worker.sessionId,
      provider: "claude",
      model: "opus",
    });
    if (!opened.allowed) return opened as unknown as Decision<{ executionId: string }>;
    const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:stand-in" }, request.runId);
    if (!closed.allowed) throw new Error(closed.message);
    return allow(ReasonCode.OK, { executionId: opened.value.executionId });
  });
  vi.spyOn(cp.workerTurns, "describe").mockImplementation((executionId) => {
    const execution = cp.tasks.execution(executionId)!;
    return allow(ReasonCode.OK, { execution: { executionId, status: execution.status } } as unknown as WorkerExecutionView);
  });
  const submit = vi.spyOn(cp.pipeline, "submitResult").mockResolvedValue(
    allow(ReasonCode.OK, { stage: "STAND_IN" }) as unknown as Awaited<ReturnType<typeof cp.pipeline.submitResult>>,
  );
  return { provision, start, submit };
};

/** A STANDARD_WORK run of a project whose PRIMARY_CTO is driven, dispatched to it, and its owner scripted. */
const dispatchedStandard = async (
  f: BootstrapRuntimeFixture,
  projectId: string,
  options: Parameters<typeof scriptStandardOwner>[2],
) => {
  const cp = f.harness.cp;
  const { bootstrap, binding } = await drivenPrimary(f, projectId);
  const repository = cp.db.get<{ repository_id: string }>(`SELECT repository_id FROM repositories WHERE project_id = ?`, [projectId])!;
  const owner = scriptStandardOwner(f, binding.sessionId, options);
  const created = cp.runs.create({
    projectId,
    kind: RunKind.STANDARD_WORK,
    executionMode: ExecutionMode.SIMPLE,
    contract: CONTRACT,
    repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const turnsBefore = f.finishedTurns(binding.sessionId);
  const dispatched = await cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  expect(dispatched.value).toMatchObject({ ownerSessionId: binding.sessionId, ownerRoleKey: binding.roleKey, ownerBindingGeneration: 1 });
  // The RUN_DISPATCH's in-band wake ran the owner's turn: waited for by its state, however long it takes.
  await f.awaitFinishedTurns(binding.sessionId, turnsBefore + 1);
  await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(binding.sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  const dispatch = cp.outbox.listByRun(runId).find((row) => row.kind === MessageKind.RUN_DISPATCH)!;
  expect(dispatch.status).toBe(options.onDispatch === "plan-no-ack" ? "PENDING" : "ACKED");
  return { owner, runId, bootstrapRunId: bootstrap.runId, sessionId: binding.sessionId, roleKey: binding.roleKey, dispatch };
};

/** The run stopped after its PLAN, as run_ab77268b did: its one task READY, no worker, no execution. */
const stalledAfterPlan = async (f: BootstrapRuntimeFixture, projectId: string, onContinuation: "follow-prompt" | "ignore") => {
  const run = await dispatchedStandard(f, projectId, { onDispatch: "plan-only", onContinuation });
  const tasks = f.harness.cp.tasks.list(run.runId);
  expect(tasks.map((task) => task.state)).toEqual([TaskState.READY]);
  const taskId = tasks[0]!.taskId;
  expect(f.harness.cp.bindings.history(roleKeyFor(Role.WORKER, { taskId }))).toEqual([]);
  expect(run.owner.calls.map((call) => call.tool)).toEqual(["contract_get", "plan_submit", "run_ack"]);
  return { ...run, taskId };
};

const markers = (f: BootstrapRuntimeFixture, kind: string, runId: string) =>
  f.harness.cp.audit.byKind(kind).filter((row) => row.runId === runId).map((row) => row.evidence);

const ticks = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startDaemon = async (f: BootstrapRuntimeFixture, name: string): Promise<Daemon> => {
  f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.harness.cp, { stateDir: tempDir(`acp-swc-${name}-`), watchdogIntervalMs: 50 });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  return daemon;
};

const nothing = { woken: [], stalled: [] };

describe("witness 1 — the driven work prompt carries a STANDARD_WORK run past its PLAN", () => {
  it("a STANDARD_WORK RUN_DISPATCH's turn staffs, claims, runs and reads its READY task, then submits the result, before run_ack", async () => {
    await withBootstrapRuntime(async (f) => {
      const standIn = standInWorkerRuntime(f);
      const { owner, runId } = await dispatchedStandard(f, "std-dispatch", { onDispatch: "follow-prompt", onContinuation: "ignore" });
      const taskId = f.harness.cp.tasks.list(runId)[0]!.taskId;
      expect(owner.calls.filter((call) => call.runId === runId).map((call) => [call.tool, call.ok])).toEqual([
        ["contract_get", true],
        ["plan_submit", true],
        ["task_worker_provision", true],
        ["resource_claim", true],
        ["task_worker_run", true],
        ["task_execution_get", true],
        ["result_submit", true],
        ["run_ack", true],
      ]);
      // The calls reached the control plane as the owner, for this task, with the provider the prompt named.
      expect(standIn.provision).toHaveBeenCalledTimes(1);
      expect(standIn.provision.mock.calls[0]![0]).toMatchObject({ runId, taskId, provider: "claude", ownerBindingGeneration: 1 });
      expect(standIn.provision.mock.calls[0]![0].model).toBeUndefined();
      expect(standIn.start.mock.calls[0]![0]).toMatchObject({ runId, taskId, ownerBindingGeneration: 1 });
      expect(standIn.submit).toHaveBeenCalledTimes(1);
      expect(f.harness.cp.tasks.require(taskId).state).toBe(TaskState.SUCCEEDED);
    });
  });

  it("the directive is the PRIMARY_CTO's alone, states the steps in order with their guards, and a BOOTSTRAP_CTO's prompt carries none of it", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner } = await dispatchedStandard(f, "std-prompt", { onDispatch: "plan-only", onContinuation: "ignore" });
      const directive = owner.prompts.at(-1)!.split("\n").find((line) => line.startsWith(STANDARD_DIRECTIVE))!;
      expect(directive).toContain("a missing bootstrapPlanGuide is no reason to stop");
      expect(directive).toContain("before you acknowledge its RUN_DISPATCH");
      const order = [
        "mcp__acp-cto__task_worker_provision",
        "mcp__acp-cto__resource_claim",
        "mcp__acp-cto__task_worker_run",
        "until that execution is no longer RUNNING",
        "mcp__acp-cto__result_submit",
      ].map((step) => directive.indexOf(step));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // Re-entry reads before it staffs; nothing is staffed or run twice; uncertainty is escalated, never retried.
      expect(directive.indexOf("first look for what already exists for that task")).toBeLessThan(order[0]!);
      expect(directive).toContain("never provisioned or run again");
      expect(directive).toContain("never retry one on your own: report it for that run with mcp__acp-cto__escalation_open");
      expect(directive).toContain("staffing no more workers at once than its contract allows");
      expect(directive).toContain('provider "claude" with no model');
      expect(directive).toContain("result_submit runs the blind review itself");
      expect(directive).toContain("Never submit that run's PLAN again");
      // The project's bootstrap run's BOOTSTRAP_CTO turns, on the same double: no worker step at all.
      const bootstrapPrompts = f.claude.turns
        .filter((turn) => turn.relay !== null && !/nonce set to/.test(turn.prompt) && /You are the BOOTSTRAP_CTO/.test(turn.prompt))
        .map((turn) => turn.prompt);
      expect(bootstrapPrompts.length).toBeGreaterThan(0);
      for (const prompt of bootstrapPrompts) {
        expect(prompt).not.toContain(STANDARD_DIRECTIVE);
        expect(prompt).not.toContain("task_worker_provision");
      }
    });
  });
});

describe("witness 2 — a run stopped after its PLAN is woken once for the same owner", () => {
  it("one continuation turn for the same owner; a second pass wakes nothing; no progress leaves one blocker, and nothing more", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, bootstrapRunId, sessionId, roleKey, taskId, dispatch } = await stalledAfterPlan(f, "std-once", "ignore");
      const turns = f.finishedTurns(sessionId);
      const tuple = { runId, roleKey, bindingGeneration: 1, taskId, taskState: TaskState.READY };
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual({ woken: [tuple], stalled: [] });
      // Observed and enqueued in one section: the turn is queued, so the next pass decides nothing.
      expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(true);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      const kind = standardWorkContinuationTriggerKind(runId, taskId);
      expect(owner.prompts.at(-1)).toContain(`The control plane woke you for: ${kind}.`);
      expect(owner.prompts.at(-1)!.split("\n").some((line) => line.startsWith(CONTINUATION_LINE))).toBe(true);
      // The woken turn did nothing: the same state, so one explicit blocker and no wake.
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual({ woken: [], stalled: [tuple] });
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      await ticks(50);
      expect(f.finishedTurns(sessionId)).toBe(turns + 1);
      const triggerId = standardWorkContinuationTriggerId(runId, 1, taskId, TaskState.READY);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([
        { bindingGeneration: 1, taskId, taskState: TaskState.READY, messageId: dispatch.messageId, triggerId },
      ]);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([
        expect.objectContaining({ bindingGeneration: 1, taskId, taskState: TaskState.READY, messageId: dispatch.messageId }),
      ]);
      const blocker = f.harness.cp.audit.byKind(STANDARD_WORK_CONTINUATION_STALLED)[0]!;
      expect(blocker).toMatchObject({ reasonCode: ReasonCode.WORKER_BINDING_REQUIRED, sessionId, roleKey });
      // The runtime refuses the same trigger again by itself, too.
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{ id: triggerId, kind }]))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_TURN_DUPLICATE });
      // The project's PROJECT_BOOTSTRAP run is never a continuation's.
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, bootstrapRunId)).toEqual([]);
      expect(f.harness.cp.tasks.require(taskId).state).toBe(TaskState.READY);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    });
  });

  it("through the daemon's own scheduling: startup and watchdog ticks wake it exactly once and record one blocker; a restarted daemon wakes nothing", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, sessionId } = await stalledAfterPlan(f, "std-ticks", "ignore");
      const turns = f.finishedTurns(sessionId);
      const first = await startDaemon(f, "first");
      try {
        await vi.waitFor(() => expect(f.finishedTurns(sessionId)).toBe(turns + 1), { timeout: 10_000, interval: 25 });
        await vi.waitFor(() => expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toHaveLength(1), { timeout: 10_000, interval: 25 });
        await ticks(400);
      } finally {
        await first.stop();
      }
      const second = await startDaemon(f, "second");
      try {
        await ticks(400);
      } finally {
        await second.stop();
      }
      expect(f.finishedTurns(sessionId)).toBe(turns + 1);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toHaveLength(1);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toHaveLength(1);
    });
  });

  it("an owner that follows the woken prompt carries the run: one provision, its task executed, the result submitted, and nothing woken again", async () => {
    await withBootstrapRuntime(async (f) => {
      const standIn = standInWorkerRuntime(f);
      const { owner, runId, sessionId, taskId } = await stalledAfterPlan(f, "std-carry", "follow-prompt");
      const turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toHaveLength(1);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      expect(owner.calls.slice(3).map((call) => [call.tool, call.ok])).toEqual([
        ["task_worker_provision", true],
        ["resource_claim", true],
        ["task_worker_run", true],
        ["task_execution_get", true],
        ["result_submit", true],
      ]);
      expect(f.harness.cp.tasks.require(taskId).state).toBe(TaskState.SUCCEEDED);
      // Progress: not the same state, so neither a wake nor a blocker; no second provision.
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([]);
      expect(standIn.provision).toHaveBeenCalledTimes(1);
      expect(f.finishedTurns(sessionId)).toBe(turns + 1);
    });
  });
});

describe("witness 4 — duplicates and wrong targets are never woken", () => {
  it("a task already staffed (queued), running, or executed: no continuation, no blocker, no second provision", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const standIn = standInWorkerRuntime(f);
      const { runId, taskId } = await stalledAfterPlan(f, "std-dup", "follow-prompt");
      const workerSessionId = bindWorkerForTask(cp, taskId, { provider: "claude", model: "opus" });
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      const opened = cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: 1, workerSessionId, provider: "claude", model: "opus" });
      if (!opened.allowed) throw new Error(opened.message);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:done" }, runId);
      if (!closed.allowed) throw new Error(closed.message);
      expect(cp.tasks.require(taskId).state).toBe(TaskState.SUCCEEDED);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([]);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([]);
      expect(standIn.provision).not.toHaveBeenCalled();
    });
  });

  it("a RUN_DISPATCH not yet acknowledged is the outbox's to deliver again, never a continuation's", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId } = await dispatchedStandard(f, "std-pending", { onDispatch: "plan-no-ack", onContinuation: "ignore" });
      expect(owner.calls.map((call) => call.tool)).toEqual(["contract_get", "plan_submit"]);
      expect(f.harness.cp.tasks.list(runId).map((task) => task.state)).toEqual([TaskState.READY]);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([]);
    });
  });

  it("a task whose execution failed and returned no worker to staff: no continuation", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { runId, taskId } = await stalledAfterPlan(f, "std-failed", "follow-prompt");
      const workerSessionId = bindWorkerForTask(cp, taskId, { provider: "claude", model: "opus" });
      const opened = cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: 1, workerSessionId, provider: "claude", model: "opus" });
      if (!opened.allowed) throw new Error(opened.message);
      const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "FAILED", failureClass: "unknown_observed" }, runId);
      if (!closed.allowed) throw new Error(closed.message);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([]);
    });
  });

  it("an owner turn running or queued: nothing is decided until it ends", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, sessionId, roleKey } = await stalledAfterPlan(f, "std-busy", "ignore");
      const release = owner.hold();
      const turns = f.finishedTurns(sessionId);
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{ id: "unrelated-turn", kind: "owner message" }]).allowed).toBe(true);
      await vi.waitFor(() => expect(owner.prompts.length).toBeGreaterThan(1), { timeout: 10_000, interval: 25 });
      expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(true);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([]);
      release();
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      // Once it ended, the same state is woken: the control proves the turn was the only thing holding it.
      expect(f.daemon.wakeStandardWorkContinuation().woken).toHaveLength(1);
    });
  });

  it("a holder this runtime does not drive or whose credential it does not hold, a stale-generation owner, and no owner at all: no continuation", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { runId, sessionId, roleKey } = await stalledAfterPlan(f, "std-owner", "ignore");
      // Not driven here.
      const drives = vi.spyOn(cp.sessionRuntime, "drivesSession").mockReturnValue(false);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      drives.mockRestore();
      // No credential held for it.
      const holds = vi.spyOn(cp.sessionRuntime, "holds").mockReturnValue(false);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      holds.mockRestore();
      // A CTO draining for a switchover: the runtime would still run its turn, the continuation does not.
      expect(cp.sessions.transition(sessionId, SessionLifecycle.DRAINING, "test: draining").allowed).toBe(true);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(cp.sessions.transition(sessionId, SessionLifecycle.READY, "test: ready again").allowed).toBe(true);
      // No owner: the role's binding revoked while the run waits, BLOCKED.
      expect(cp.runs.transition(runId, RunState.BLOCKED, "test: blocked for the revocation").allowed).toBe(true);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      const revoked = cp.bindings.revoke(roleKey, "test: revoked", { allowBlockedRuns: true });
      expect(revoked.allowed).toBe(true);
      expect(cp.runs.transition(runId, RunState.ACTIVE, "test: active with a revoked owner").allowed).toBe(true);
      expect(cp.bindings.active(roleKey)).toBeNull();
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      // A later generation of the role on another session, while the run is still pinned to the first:
      // the role's holder is not the run's owner, so neither is woken.
      expect(cp.runs.transition(runId, RunState.BLOCKED, "test: blocked for the rebind").allowed).toBe(true);
      const successor = cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
      expect(cp.sessions.transition(successor.sessionId, SessionLifecycle.READY, "test: successor").allowed).toBe(true);
      const rebound = cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: successor.sessionId, projectId: "std-owner" });
      expect(rebound).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });
      expect(cp.runs.transition(runId, RunState.ACTIVE, "test: active, pinned to the first generation").allowed).toBe(true);
      expect(cp.runs.require(runId)).toMatchObject({ state: RunState.ACTIVE, ownerBindingGeneration: 1 });
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([]);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([]);
    });
  });

  it("a run in CEO review, waiting on the CEO or a human, a continuity or capacity hold, a result under review, and a cancelled run: no continuation", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { runId, sessionId } = await stalledAfterPlan(f, "std-held", "ignore");
      // SURVIVAL holds new work.
      const mode = vi.spyOn(cp.continuity, "mode").mockReturnValue(ContinuityMode.SURVIVAL);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      mode.mockRestore();
      // A result submitted, under its blind review or reviewed.
      const candidate = vi.spyOn(cp.runs, "currentCandidate").mockReturnValue("sha256:candidate");
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      candidate.mockRestore();
      for (const held of [RunState.BLOCKED, RunState.AWAITING_HUMAN]) {
        expect(cp.runs.transition(runId, held, `test: ${held}`).allowed).toBe(true);
        expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
        expect(cp.runs.transition(runId, RunState.ACTIVE, "test: active again").allowed).toBe(true);
      }
      // The control: with every hold lifted, the same run is woken, once.
      const turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toHaveLength(1);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      // At CEO review: neither a wake nor a blocker, though the woken turn made no progress.
      expect(cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "test: at CEO review").allowed).toBe(true);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(cp.runs.transition(runId, RunState.AWAITING_HUMAN, "test: waiting on a human").allowed).toBe(true);
      expect(cp.runs.cancel(runId, "test: cancelled").allowed).toBe(true);
      expect(cp.runs.require(runId).state).toBe(RunState.CANCELLED);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      // The cancelled run's one wake stays its only one, and no blocker is left for a run that ended.
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toHaveLength(1);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([]);
    });
  });
});
