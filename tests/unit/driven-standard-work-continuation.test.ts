import { frontierReviewPolicy } from "../../src/review/frontier-simplify-policy.ts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import {
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
  STANDARD_CONTINUATION_STATE,
  STANDARD_WORK_CONTINUATION_STALLED,
  STANDARD_WORK_CONTINUATION_WAKE,
  standardWorkContinuationTriggerId,
  standardWorkContinuationTriggerKind,
} from "../../src/runtime/provisioned-session-runtime.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { planCarrying, stricter } from "../helpers/contract-change.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
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
 * The canonical live target is #512: run_ab77268bab3d4ff482f7348e, left after its PLAN at task_e959ee8b
 * READY with no worker.
 *
 * Over the real sockets, launch channel and in-band wake; only the model is scripted, and its work
 * turn does what its prompt says. Where a row needs a worker to run, the control plane's worker
 * runtime is stood in for by real task records (a WORKER binding, an execution and its receipt).
 */

/**
 * The continuation's state component (CEO e64aa10b): a READY task nothing was started for, and one whose
 * worker was provisioned and never ran. Literals here, checked against the export once the behaviour is,
 * so a tree without the export fails on behaviour rather than on a missing name.
 */
const UNSTAFFED = "READY";
const STAFFED = "READY_WORKER_PROVISIONED";

/** The work branch a run's contract names: a PLAN declares it as its tasks' write target (CEO e64aa10b). */
const WORK_BRANCH = "task/readme";

const contractFor = (branch: string) => ({
  goal: "update the README",
  why: "one documentation change",
  scope: ["README.md"],
  nonGoals: [],
  acceptance: ["README.md documents the project"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [`work branch: ${branch}`],
});

/** The STANDARD_WORK directive's opening, which names the runs it is for (CEO 07b5b0df). */
const STANDARD_DIRECTIVE = "For a STANDARD_WORK run (contract_get's run.kind), a missing bootstrapPlanGuide is no reason to stop";
/**
 * The opening the directive had at d848191b and before, for every run with no bootstrapPlanGuide. The
 * stand-in reads it as that prompt states it, so a tree that still says it shows what that prompt does.
 */
const GENERIC_DIRECTIVE = "For a run whose contract_get returned no bootstrapPlanGuide";
const CONTINUATION_LINE = 'A wake for "standard work continuation: run <runId> has READY task <taskId> with no worker"';
const CONTINUATION_KIND = /standard work continuation: run (\S+) has READY task (\S+) with (?:no worker|a provisioned worker and no execution)/;

/**
 * The directive's clauses, word for word as the prompt states them. The stand-in model acts on a
 * clause only when the turn's prompt carries it, and on nothing else: no step of its own (CEO 07b5b0df).
 */
const CLAUSE = {
  /** The run's record, read through contract_get, is what every step goes by. */
  record: "its tasks list each task's taskId, state, spec, worker and executions, and they are the record to go by",
  /** Which tasks are taken: every one, whatever its state. */
  everyTask: "Then take every task of the run, whatever its state, in turn.",
  /** A task's existing execution is read first, by its id. */
  readNewest: "First, if the task has executions, read its newest execution with mcp__acp-cto__task_execution_get by that executionId",
  /** A RUNNING execution is read until it settles. */
  untilSettled: "while that execution is RUNNING, read it again until it is not",
  /** A SUCCEEDED execution leaves its task done. */
  succeededDone: "an execution that SUCCEEDED leaves its task done",
  /** Anything else, or an unreadable one, is escalated. */
  failedEscalate: "an execution that did not succeed, or one you cannot read, is reported for that run with mcp__acp-cto__escalation_open",
  /** Only a READY task with no execution gets a first execution. */
  firstExecution: "Only a READY task with no execution gets a first execution",
  reuseWorker: "reuse its worker if it has one and never provision another",
  inactiveWorker: "a worker whose state is not ACTIVE is reported with mcp__acp-cto__escalation_open",
  provision: "otherwise staff it with mcp__acp-cto__task_worker_provision",
  claim: "exactly as its spec's writeTarget names it",
  missingTarget: "when the spec names no writeTarget, report it with mcp__acp-cto__escalation_open",
  run: "start that first execution with mcp__acp-cto__task_worker_run",
  readReturned: "read the execution it returns as above",
  leaveOthers: "A task with no execution that is not READY is left as it is.",
  result: "Once every task of the run has SUCCEEDED, submit the run's result with mcp__acp-cto__result_submit",
  refusal: "A refused provision, claim or task_worker_run is reported for that run with mcp__acp-cto__escalation_open",
  /** What a PLAN gives each task. */
  planWriteTarget: "give each task's spec a writeTarget",
} as const;

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

interface RecordTask {
  taskId: string;
  state: string;
  spec: { writeTarget?: { repositoryIdentity: string; branch: string; paths: string[] } };
  worker: { sessionId: string; state: string } | null;
  executions: Array<{ executionId: string; state: string }>;
}

/**
 * A scripted stand-in for the driven PRIMARY_CTO's model, acting only through the acp-cto tools with
 * the credential its relay took for the turn, and doing only what its prompt literally says (CEO
 * 07b5b0df): it keeps no task, worker or execution id across turns, and each step below happens only
 * when the turn's prompt carries the clause (`CLAUSE`) that states it. What the prompt does not
 * state, it does not do.
 *
 * - A RUN_DISPATCH it holds no PLAN for: `contract_get`, then one `plan_submit` with one docs task,
 *   whose spec carries a writeTarget when the prompt asks for one (the repository contract_get
 *   returned, the work branch the contract names, README.md); a CONTRACT_CHANGE run's PLAN carries a
 *   stricter manifest, as that run's contract requires. Then, when `onDispatch` is
 *   `"follow-prompt"`, it carries the run if the prompt's directive is for that run: the
 *   STANDARD_WORK directive for a STANDARD_WORK run, or the generic one d848191b had for any run with
 *   no bootstrapPlanGuide. `"plan-only"` carries nothing (the stall observed live on run_ab77268b);
 *   `"plan-no-ack"` leaves the RUN_DISPATCH unacknowledged as well.
 * - `onContinuation: "follow-prompt"` carries the run a continuation wake names when the prompt
 *   carries that wake's line; `"ignore"` answers such a wake with no tool call at all.
 * - Every row it read is acknowledged with `run_ack` last.
 */
const scriptStandardOwner = (
  f: BootstrapRuntimeFixture,
  sessionId: string,
  options: { onDispatch: "follow-prompt" | "plan-only" | "plan-no-ack"; onContinuation: "follow-prompt" | "ignore" },
): StandardOwner => {
  let gate: Promise<void> | null = null;
  /** Only that a run was planned: the stand-in keeps no task, worker or execution id across turns. */
  const planned = new Set<string>();
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
    const directive = lines.find((line) => line.startsWith(STANDARD_DIRECTIVE) || line.startsWith(GENERIC_DIRECTIVE)) ?? null;
    /** Whether the directive is for a run of this kind, as its opening words say. */
    const directiveFor = (kind: string | undefined): boolean =>
      directive !== null && (directive.startsWith(GENERIC_DIRECTIVE) || kind === RunKind.STANDARD_WORK);
    const says = (clause: string): boolean => directive !== null && directive.includes(clause);
    const provider = directive === null ? null : /provider "([^"]+)"/.exec(directive)?.[1] ?? null;

    const readContract = async (runId: string): Promise<Record<string, unknown> | undefined> =>
      (await call("contract_get", runId, null, { runId }))["value"] as Record<string, unknown> | undefined;
    const escalate = (runId: string, taskId: string | null, question: string) =>
      call("escalation_open", runId, taskId, {
        idempotencyKey: `std-owner-${++keys}`, runId, question,
        options: ["investigate"], ctoRecommendation: "investigate", whyItMatters: "the run cannot complete", blocksCriticalPath: true,
      });
    /**
     * One execution, read as the directive says: once by its id, again while it is RUNNING when the
     * directive says so; then done if it SUCCEEDED, escalated if not or if unreadable. "stop" when the
     * directive says nothing that covers what was read.
     */
    const readAsSaid = async (runId: string, taskId: string, executionId: string): Promise<"done" | "escalated" | "stop"> => {
      const readOnce = async (): Promise<string | null> => {
        const answer = await call("task_execution_get", runId, taskId, { runId, executionId });
        return answer["ok"] === true ? (answer["value"] as { execution: { status: string } }).execution.status : null;
      };
      let state = await readOnce();
      // A bounded wait: the harness's own guard, never reached by a row that settles.
      for (let again = 0; state === "RUNNING" && says(CLAUSE.untilSettled) && again < 500; again += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = await readOnce();
      }
      if (state === "SUCCEEDED" && says(CLAUSE.succeededDone)) return "done";
      if (state !== "SUCCEEDED" && state !== "RUNNING" && says(CLAUSE.failedEscalate)) {
        await escalate(runId, taskId, `the task's execution ended ${state ?? "unreadable"}`);
        return "escalated";
      }
      return "stop";
    };

    /** The directive's steps for one run, from the run's record alone and as far as its clauses go. */
    const carry = async (runId: string): Promise<void> => {
      if (!says(CLAUSE.record)) return;
      const contract = await readContract(runId);
      if (!says(CLAUSE.everyTask)) return;
      const repositories = (contract?.["repositories"] as Array<{ identity: string; checkoutPath: string }> | undefined) ?? [];
      const tasks = (contract?.["tasks"] as RecordTask[] | undefined) ?? [];
      if (tasks.length === 0) return;
      const done = new Set<string>();
      for (const task of tasks) {
        const newest = task.executions.at(-1);
        if (newest) {
          if (!says(CLAUSE.readNewest)) return;
          if ((await readAsSaid(runId, task.taskId, newest.executionId)) !== "done") return;
          done.add(task.taskId);
          continue;
        }
        if (task.state !== "READY") {
          if (says(CLAUSE.leaveOthers)) continue;
          return;
        }
        if (!says(CLAUSE.firstExecution)) return;
        if (task.worker !== null) {
          if (task.worker.state !== "ACTIVE") {
            if (says(CLAUSE.inactiveWorker)) await escalate(runId, task.taskId, "the task's worker is no longer ACTIVE");
            return;
          }
          if (!says(CLAUSE.reuseWorker)) return;
        } else {
          if (!says(CLAUSE.provision) || provider === null) return;
          const provisioned = await call("task_worker_provision", runId, task.taskId, {
            idempotencyKey: `std-owner-${++keys}`, runId, taskId: task.taskId, provider,
          });
          if (provisioned["ok"] !== true) {
            if (says(CLAUSE.refusal)) await escalate(runId, task.taskId, "task_worker_provision was refused");
            return;
          }
        }
        if (!says(CLAUSE.claim)) return;
        const target = task.spec.writeTarget;
        const repository = target && repositories.find((candidate) => candidate.identity === target.repositoryIdentity);
        if (!target || !repository) {
          if (says(CLAUSE.missingTarget)) await escalate(runId, task.taskId, "the task's spec names no writeTarget");
          return;
        }
        const claimed = await call("resource_claim", runId, task.taskId, {
          idempotencyKey: `std-owner-${++keys}`, runId, repositoryIdentity: target.repositoryIdentity,
          branch: target.branch, worktreeId: repository.checkoutPath, declaredPaths: target.paths,
        });
        if (claimed["ok"] !== true) {
          if (says(CLAUSE.refusal)) await escalate(runId, task.taskId, "resource_claim was refused");
          return;
        }
        if (!says(CLAUSE.run)) return;
        const claimId = (claimed["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims
          .find((claim) => claim.worktreeId !== null)!.claimId;
        const ran = await call("task_worker_run", runId, task.taskId, { idempotencyKey: `std-owner-${++keys}`, runId, taskId: task.taskId, claimId });
        if (ran["ok"] !== true) {
          if (says(CLAUSE.refusal)) await escalate(runId, task.taskId, `task_worker_run was refused: ${String(ran["reasonCode"])}`);
          return;
        }
        if (!says(CLAUSE.readReturned)) return;
        if ((await readAsSaid(runId, task.taskId, (ran["value"] as { executionId: string }).executionId)) !== "done") return;
        done.add(task.taskId);
      }
      if (says(CLAUSE.result) && tasks.every((task) => done.has(task.taskId))) {
        await call("result_submit", runId, null, {
          idempotencyKey: `std-owner-${++keys}`, runId, resultSummary: "README.md updated", recommendation: "merge",
        });
      }
    };

    const woke = CONTINUATION_KIND.exec(lines.find((line) => line.startsWith("The control plane woke you for:")) ?? "");
    if (woke && options.onContinuation === "follow-prompt" && lines.some((line) => line.startsWith(CONTINUATION_LINE))) {
      await carry(woke[1]!);
    }

    const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; runId: string | null; kind: string }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      if (message.kind === MessageKind.RUN_DISPATCH && message.runId && !planned.has(message.runId)) {
        const runId = message.runId;
        const contract = await readContract(runId);
        const guided = Boolean(contract?.["bootstrapPlanGuide"]);
        const kind = (contract?.["run"] as { kind?: string } | undefined)?.kind;
        // The write target the prompt asks a PLAN to declare: the repository contract_get returned and
        // the work branch the run's contract names.
        const repository = (contract?.["repositories"] as Array<{ identity: string }> | undefined)?.[0];
        const references = ((contract?.["contract"] as { references?: string[] } | null)?.references ?? []).join("\n");
        const branch = /work branch: (\S+)/.exec(references)?.[1];
        const spec = says(CLAUSE.planWriteTarget) && directiveFor(kind) && repository && branch
          ? { writeTarget: { repositoryIdentity: repository.identity, branch, paths: ["README.md"] } }
          : {};
        const plan = kind === RunKind.CONTRACT_CHANGE
          ? planCarrying(stricter(f.harness.cp.projects.manifest(contract!["pinnedManifestDigest"] as string)!))
          : { summary: "one README.md change by one worker" };
        const submitted = await call("plan_submit", runId, null, {
          idempotencyKey: `std-owner-${++keys}`,
          runId,
          plan,
          tasks: [{ key: "readme", title: "update README.md", category: "docs", spec }],
        });
        if (submitted["ok"] === true) {
          planned.add(runId);
          if (!guided && options.onDispatch === "follow-prompt" && directiveFor(kind)) await carry(runId);
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
  branch: string = WORK_BRANCH,
  kind: RunKind = RunKind.STANDARD_WORK,
) => {
  const cp = f.harness.cp;
  const { bootstrap, binding } = await drivenPrimary(f, projectId);
  const repository = cp.db.get<{ repository_id: string }>(`SELECT repository_id FROM repositories WHERE project_id = ?`, [projectId])!;
  const owner = scriptStandardOwner(f, binding.sessionId, options);
  const created = cp.runs.create({
    projectId,
    kind,
    executionMode: ExecutionMode.SIMPLE,
    contract: contractFor(branch),
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

/**
 * The owner's binding generation moves from 1 to `generation` on the same driven session, with the
 * run's pin and its acknowledged RUN_DISPATCH at the new generation, as a takeover repoint or a
 * renewal followed by a RUN_DISPATCH the owner acknowledged would leave them. A driven PRIMARY_CTO
 * has no same-session renewal a test can drive, so the reads the continuation makes are moved
 * instead, and only those: the run's pin, the role's ACTIVE binding, the owner fence, and the
 * RUN_DISPATCH it looks up for the pinned generation. Everything else (the session, its driven
 * record, the runtime's custody and lane, the tasks and the audit trail) is the real one.
 */
const moveOwnerGeneration = (f: BootstrapRuntimeFixture, runId: string, roleKey: string, generation: number): void => {
  const cp = f.harness.cp;
  const realRun = cp.runs.get.bind(cp.runs);
  vi.spyOn(cp.runs, "get").mockImplementation((id) => {
    const run = realRun(id);
    return run && id === runId ? { ...run, ownerBindingGeneration: generation } : run;
  });
  const realActive = cp.bindings.active.bind(cp.bindings);
  vi.spyOn(cp.bindings, "active").mockImplementation((key) => {
    const binding = realActive(key);
    return binding && key === roleKey ? { ...binding, bindingGeneration: generation } : binding;
  });
  const realAssertOwner = cp.runs.assertOwner.bind(cp.runs);
  vi.spyOn(cp.runs, "assertOwner").mockImplementation((id, sessionId, bindingGeneration) =>
    id === runId && bindingGeneration === generation ? allow(ReasonCode.OK, realRun(id)!) : realAssertOwner(id, sessionId, bindingGeneration));
  const realGet = cp.db.get.bind(cp.db);
  vi.spyOn(cp.db, "get").mockImplementation(((sql: string, params: unknown[] = []) =>
    realGet(
      sql,
      /kind = 'RUN_DISPATCH'/.test(sql) && params[0] === runId && params[1] === generation ? [runId, 1, ...params.slice(2)] : params,
    )) as typeof cp.db.get);
};

/** A WORKER bound the way staffing binds one: its own READY Claude/Opus session, scoped to the run, task and project. */
const bindRunWorker = (f: BootstrapRuntimeFixture, runId: string, taskId: string) => {
  const cp = f.harness.cp;
  const session = cp.sessions.create({ provider: "claude", model: "opus" });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test worker").allowed).toBe(true);
  const bound = cp.bindings.bind({ role: Role.WORKER, sessionId: session.sessionId, runId, taskId, projectId: cp.runs.require(runId).projectId });
  if (!bound.allowed) throw new Error(bound.message);
  return { sessionId: session.sessionId, sessionSecret: session.sessionSecret ?? null };
};

/**
 * The real worker path with only the provider stood in: the Claude double is the WORKER's provider,
 * and its capacity admission (the provider's own reading) admits. Provisioning, the claim,
 * task_worker_run with every check the runner makes, and its execution records are the control
 * plane's own. The double launches no worker process, so a started execution ends FAILED.
 */
const realWorkerRuntime = (f: BootstrapRuntimeFixture) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return { provision: vi.spyOn(cp.workers, "provision"), start: vi.spyOn(cp.workerTurns, "start") };
};

/** The registered checkout, on `branch` and clean, as a run's work branch is before its worker runs. */
const checkoutOn = (f: BootstrapRuntimeFixture, branch: string): void => {
  gitSync(f.harness.repoPath, ["checkout", "-q", "-b", branch]);
};

const idle = (f: BootstrapRuntimeFixture, sessionId: string) =>
  vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });

/** The tools a turn called, with each run of task_execution_get reads folded into one. */
const toolsOf = (calls: StandardOwner["calls"]) =>
  calls
    .map((call) => [call.tool, call.ok] as const)
    .filter(([tool], index, all) => !(tool === "task_execution_get" && all[index - 1]?.[0] === "task_execution_get"));

describe("witness 1 — the driven work prompt carries a STANDARD_WORK run past its PLAN", () => {
  it("a STANDARD_WORK RUN_DISPATCH's turn staffs, claims, runs and reads its READY task, then submits the result, before run_ack", async () => {
    await withBootstrapRuntime(async (f) => {
      const standIn = standInWorkerRuntime(f);
      const { owner, runId } = await dispatchedStandard(f, "std-dispatch", { onDispatch: "follow-prompt", onContinuation: "ignore" });
      const taskId = f.harness.cp.tasks.list(runId)[0]!.taskId;
      // Updated for CEO e64aa10b (R1-01): the turn reads the run's record through contract_get before it
      // staffs, rather than going by what its conversation kept.
      expect(owner.calls.filter((call) => call.runId === runId).map((call) => [call.tool, call.ok])).toEqual([
        ["contract_get", true],
        ["plan_submit", true],
        ["contract_get", true],
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
      // Updated for CEO 07b5b0df (R1-01, R2-01): the directive is for STANDARD_WORK runs, takes every
      // task whatever its state, reads an existing execution by its id first and until it settles, and
      // gives a first execution only to a READY task with none. Each clause the stand-in acts on is here,
      // word for word, in the order a task meets it.
      const order = [
        CLAUSE.record,
        CLAUSE.everyTask,
        CLAUSE.readNewest,
        CLAUSE.untilSettled,
        CLAUSE.succeededDone,
        CLAUSE.failedEscalate,
        CLAUSE.firstExecution,
        CLAUSE.reuseWorker,
        CLAUSE.inactiveWorker,
        CLAUSE.provision,
        CLAUSE.claim,
        CLAUSE.missingTarget,
        CLAUSE.run,
        CLAUSE.readReturned,
        CLAUSE.leaveOthers,
        CLAUSE.result,
        CLAUSE.refusal,
        CLAUSE.planWriteTarget,
      ].map((clause) => directive.indexOf(clause));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(directive).toContain("never run an execution again or retry one on your own");
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
      const triggerId = standardWorkContinuationTriggerId(runId, taskId, TaskState.READY);
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
      // Updated for CEO e64aa10b (R1-01): the woken turn reads the run's record first.
      expect(owner.calls.slice(3).map((call) => [call.tool, call.ok])).toEqual([
        ["contract_get", true],
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

describe("CEO 0d55e1de — a change of the owner's binding generation is not progress", () => {
  it("the same READY state after a generation change: no second wake, and its one blocker is recorded instead", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, sessionId, roleKey, taskId } = await stalledAfterPlan(f, "std-gen-wake", "ignore");
      const turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toEqual([expect.objectContaining({ bindingGeneration: 1, taskId })]);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      moveOwnerGeneration(f, runId, roleKey, 2);
      // The control: the owner at generation 2 is a valid continuation target in every other respect.
      expect(f.harness.cp.runs.require(runId).ownerBindingGeneration).toBe(2);
      expect(f.harness.cp.sessionRuntime.drivesSession(sessionId, Role.PRIMARY_CTO)).toBe(true);
      const report = f.daemon.wakeStandardWorkContinuation();
      expect(report.woken).toEqual([]);
      expect(report.stalled).toEqual([{ runId, roleKey, bindingGeneration: 2, taskId, taskState: TaskState.READY }]);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      await ticks(50);
      expect(f.finishedTurns(sessionId)).toBe(turns + 1);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([expect.objectContaining({ bindingGeneration: 1, taskId })]);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([expect.objectContaining({ bindingGeneration: 2, taskId })]);
    });
  });

  it("after the blocker, a later generation change: no wake and no second blocker, at generation 2 or 3", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, sessionId, roleKey, taskId } = await stalledAfterPlan(f, "std-gen-stalled", "ignore");
      const turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toHaveLength(1);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      expect(f.daemon.wakeStandardWorkContinuation().stalled).toHaveLength(1);
      for (const generation of [2, 3]) {
        vi.restoreAllMocks();
        moveOwnerGeneration(f, runId, roleKey, generation);
        expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
        expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      }
      await ticks(50);
      expect(f.finishedTurns(sessionId)).toBe(turns + 1);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId)).toEqual([expect.objectContaining({ bindingGeneration: 1, taskId })]);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([expect.objectContaining({ bindingGeneration: 1, taskId })]);
    });
  });

  it("real progress still earns exactly one wake for the new state, and a generation change after it earns none", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { runId, sessionId, roleKey, taskId } = await stalledAfterPlan(f, "std-gen-progress", "ignore");
      // A second task of the run, READY behind the first.
      const second = cp.tasks.submit(runId, [{ key: "notes", title: "update the release notes", category: "docs" }]);
      if (!second.allowed) throw new Error(second.message);
      const nextTaskId = second.value[0]!.taskId;
      let turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toEqual([expect.objectContaining({ taskId })]);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      expect(f.daemon.wakeStandardWorkContinuation().stalled).toEqual([expect.objectContaining({ taskId })]);
      // Progress: the first task is staffed and executed, so the second is the run's state now.
      const workerSessionId = bindWorkerForTask(cp, taskId, { provider: "claude", model: "opus" });
      const opened = cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: 1, workerSessionId, provider: "claude", model: "opus" });
      if (!opened.allowed) throw new Error(opened.message);
      const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:first" }, runId);
      if (!closed.allowed) throw new Error(closed.message);
      turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual({
        woken: [{ runId, roleKey, bindingGeneration: 1, taskId: nextTaskId, taskState: TaskState.READY }],
        stalled: [],
      });
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      moveOwnerGeneration(f, runId, roleKey, 2);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toEqual([]);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(f.finishedTurns(sessionId)).toBe(turns + 1);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId).map((evidence) => evidence["taskId"])).toEqual([taskId, nextTaskId]);
    });
  });
});

describe("R1-01 (a), CEO e64aa10b — contract_get gives a STANDARD_WORK run's current owner its tasks, workers and executions, and no one else", () => {
  it("the owner reads each task's state, spec, worker and executions; another run's owner, the repo-factory BOOTSTRAP_CTO and a stale-generation owner are refused; no secret is in it", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { runId, sessionId, roleKey, taskId, bootstrapRunId } = await stalledAfterPlan(f, "std-record", "ignore");
      const read = (as: string, id: string) => f.cto(as, "contract_get", { runId: id });
      const tasksOf = (answer: Record<string, unknown>) => (answer["value"] as { tasks?: unknown } | undefined)?.tasks;
      expect(tasksOf(await read(sessionId, runId))).toEqual([expect.objectContaining({
        taskId,
        state: TaskState.READY,
        spec: { writeTarget: { repositoryIdentity: "github:acme/fixture", branch: WORK_BRANCH, paths: ["README.md"] } },
        worker: null,
        executions: [],
      })]);
      const worker = bindRunWorker(f, runId, taskId);
      expect(tasksOf(await read(sessionId, runId))).toEqual([expect.objectContaining({
        taskId,
        worker: { sessionId: worker.sessionId, generation: 1, state: "ACTIVE", sessionLifecycle: "READY" },
        executions: [],
      })]);
      const opened = cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: 1, workerSessionId: worker.sessionId, provider: "claude", model: "opus" });
      if (!opened.allowed) throw new Error(opened.message);
      const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "FAILED", failureClass: "unknown_observed" }, runId);
      if (!closed.allowed) throw new Error(closed.message);
      const owned = await read(sessionId, runId);
      expect(tasksOf(owned)).toEqual([expect.objectContaining({
        taskId,
        state: TaskState.FAILED,
        executions: [{ executionId: opened.value.executionId, state: "FAILED", attempt: 1, startedAt: expect.any(String), endedAt: expect.any(String) }],
      })]);
      // Identities and states only: no field that names a credential, and no session's secret.
      const keysOf = (value: unknown): string[] =>
        Array.isArray(value) ? value.flatMap(keysOf)
          : value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]) : [];
      expect(keysOf(tasksOf(owned)).filter((key) => /secret|token|credential|password|pid|process/i.test(key))).toEqual([]);
      const text = JSON.stringify(owned);
      expect(text).not.toContain(f.claude.credentials.get(sessionId)!.sessionSecret);
      if (worker.sessionSecret) expect(text).not.toContain(worker.sessionSecret);
      // Another run: the owner asks for the project's bootstrap run, and that run's own owner (the
      // repo-factory BOOTSTRAP_CTO) asks for this one. Neither sees anything.
      const otherRun = await read(sessionId, bootstrapRunId);
      expect(otherRun["ok"]).toBe(false);
      const bootstrapOwner = cp.runs.require(bootstrapRunId).ownerSessionId!;
      const repoFactory = await read(bootstrapOwner, runId);
      expect(repoFactory).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
      expect(JSON.stringify(repoFactory)).not.toContain(taskId);
      // A stale generation: the role rebound to another session while the run is pinned to the first.
      expect(cp.runs.transition(runId, RunState.BLOCKED, "test: blocked for the rebind").allowed).toBe(true);
      expect(cp.bindings.revoke(roleKey, "test: revoked", { allowBlockedRuns: true }).allowed).toBe(true);
      const successor = cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
      expect(cp.sessions.transition(successor.sessionId, SessionLifecycle.READY, "test: successor").allowed).toBe(true);
      expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: successor.sessionId, projectId: "std-record" })).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });
      expect(cp.runs.transition(runId, RunState.ACTIVE, "test: active, pinned to the first generation").allowed).toBe(true);
      const stale = await read(sessionId, runId);
      expect(stale["ok"]).toBe(false);
      expect(JSON.stringify(stale)).not.toContain(taskId);
      expect(JSON.stringify(stale)).not.toContain(opened.value.executionId);
    });
  });
});

describe("R1-01 (b), CEO e64aa10b — re-entry goes by the run's record, and a provisioned worker that never ran resumes once", () => {
  it("review probe 1, ported: a worker provisioned before an interruption is reused from the record, never provisioned again, and its first execution starts on the real runner", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const real = realWorkerRuntime(f);
      // #512 S-TB (c98ea8a3): the control plane makes the declared branch at the run's pinned base; a branch
      // pre-created by anyone else is refused, so the checkout stays on the run's base branch here.
      const { owner, runId, sessionId, taskId } = await stalledAfterPlan(f, "std-reentry", "follow-prompt");
      // The interrupted turn: the owner provisioned the task's worker through the real tool, then ended.
      const provisioned = await f.cto(sessionId, "task_worker_provision", { runId, taskId, provider: "claude" });
      expect(provisioned).toMatchObject({ ok: true });
      const workerSessionId = (provisioned["value"] as { workerSessionId: string }).workerSessionId;
      expect(cp.tasks.executions(runId)).toEqual([]);
      // What the probe found still holds: a worker's session id is no execution id.
      expect(await f.cto(sessionId, "task_execution_get", { runId, executionId: workerSessionId }))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
      const turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken)
        .toEqual([expect.objectContaining({ taskId, taskState: STAFFED })]);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await idle(f, sessionId);
      expect(owner.prompts.at(-1)).toContain(
        `The control plane woke you for: ${standardWorkContinuationTriggerKind(runId, taskId, STAFFED)}.`,
      );
      // The woken turn read the record, reused the worker, claimed the declared target and started the
      // first execution; the double runs no worker process, so it ended FAILED, which is escalated.
      expect(toolsOf(owner.calls.slice(3))).toEqual([
        ["contract_get", true],
        ["resource_claim", true],
        ["task_worker_run", true],
        ["task_execution_get", true],
        ["escalation_open", true],
      ]);
      expect(real.provision).toHaveBeenCalledTimes(1);
      expect(cp.tasks.executions(runId)).toEqual([expect.objectContaining({ runtimeManaged: true, workerSessionId, status: "FAILED" })]);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
    });
  });

  it("review probe 2, ported: an execution whose id the conversation lost is found again in the record and read until it settles; the task is never run again", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const submit = vi.spyOn(cp.pipeline, "submitResult").mockResolvedValue(
        allow(ReasonCode.OK, { stage: "STAND_IN" }) as unknown as Awaited<ReturnType<typeof cp.pipeline.submitResult>>,
      );
      const run = realWorkerRuntime(f);
      const { owner, runId, sessionId, roleKey, taskId } = await stalledAfterPlan(f, "std-lost", "follow-prompt");
      const worker = bindRunWorker(f, runId, taskId);
      const opened = cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: 1, workerSessionId: worker.sessionId, provider: "claude", model: "opus" });
      if (!opened.allowed) throw new Error(opened.message);
      // A running execution is never a continuation's; the owner re-enters on another wake carrying the
      // same line, and the stand-in model keeps no id: only the record names the execution.
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      const turns = f.finishedTurns(sessionId);
      expect(cp.sessionRuntime.wake(roleKey, [{ id: "re-entry", kind: standardWorkContinuationTriggerKind(runId, taskId) }]).allowed).toBe(true);
      await vi.waitFor(() => expect(owner.calls.some((call) => call.tool === "task_execution_get" && call.ok)).toBe(true), { timeout: 10_000, interval: 10 });
      const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:lost" }, runId);
      if (!closed.allowed) throw new Error(closed.message);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await idle(f, sessionId);
      expect(toolsOf(owner.calls.slice(3))).toEqual([
        ["contract_get", true],
        ["task_execution_get", true],
        ["result_submit", true],
      ]);
      expect(run.provision).not.toHaveBeenCalled();
      expect(run.start).not.toHaveBeenCalled();
      expect(cp.tasks.executions(runId)).toHaveLength(1);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  it("a task whose worker was provisioned and never ran is a state of its own: woken once, its own blocker after no progress; a revoked worker never is", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { owner, runId, sessionId, roleKey, taskId } = await stalledAfterPlan(f, "std-staffed", "ignore");
      let turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toEqual([expect.objectContaining({ taskId, taskState: UNSTAFFED })]);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await idle(f, sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().stalled).toEqual([expect.objectContaining({ taskId, taskState: UNSTAFFED })]);
      // A worker bound, then revoked before it ran: continuity's to answer, never a continuation's.
      bindRunWorker(f, runId, taskId);
      const workerRole = roleKeyFor(Role.WORKER, { taskId });
      expect(cp.bindings.revoke(workerRole, "test: revoked before it ran").allowed).toBe(true);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      // Bound again and ACTIVE, never run: progress to a state of its own, woken once.
      bindRunWorker(f, runId, taskId);
      turns = f.finishedTurns(sessionId);
      const staffed = { runId, roleKey, bindingGeneration: 1, taskId, taskState: STAFFED };
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual({ woken: [staffed], stalled: [] });
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await idle(f, sessionId);
      expect(owner.prompts.at(-1)).toContain(
        `The control plane woke you for: ${standardWorkContinuationTriggerKind(runId, taskId, STAFFED)}.`,
      );
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual({ woken: [], stalled: [staffed] });
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(f.finishedTurns(sessionId)).toBe(turns + 1);
      expect(markers(f, STANDARD_WORK_CONTINUATION_WAKE, runId).map((evidence) => evidence["taskState"]))
        .toEqual([UNSTAFFED, STAFFED]);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId).map((evidence) => evidence["taskState"]))
        .toEqual([UNSTAFFED, STAFFED]);
      expect(cp.tasks.executions(runId)).toEqual([]);
      expect(STANDARD_CONTINUATION_STATE).toEqual({ UNSTAFFED, STAFFED });
    });
  });
});

describe("R1-01 (c), CEO e64aa10b — the real claim and runner take the write target the PLAN declared", () => {
  it("review probe 4, ported: the real resource_claim and task_worker_run start an execution on the declared target; a branch the checkout is not on is refused, escalated and never replaced", async () => {
    // Correct target: the PLAN declared the work branch, which the control plane makes on the registered checkout.
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const real = realWorkerRuntime(f);
      // #512 S-TB (c98ea8a3): the control plane makes the declared branch at the run's pinned base; a branch
      // pre-created by anyone else is refused, so the checkout stays on the run's base branch here.
      const { owner, runId } = await dispatchedStandard(f, "std-real", { onDispatch: "follow-prompt", onContinuation: "ignore" });
      expect(toolsOf(owner.calls.filter((call) => call.runId === runId))).toEqual([
        ["contract_get", true],
        ["plan_submit", true],
        ["contract_get", true],
        ["task_worker_provision", true],
        ["resource_claim", true],
        ["task_worker_run", true],
        ["task_execution_get", true],
        ["escalation_open", true],
        ["run_ack", true],
      ]);
      expect(real.provision).toHaveBeenCalledTimes(1);
      const executions = cp.tasks.executions(runId);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({ runtimeManaged: true, provider: "claude", model: "opus" });
      expect(cp.db.all(`SELECT branch FROM resource_claims WHERE run_id = ? AND branch IS NOT NULL`, [runId])).toEqual([{ branch: WORK_BRANCH }]);
      expect(cp.db.all(`SELECT declared_path FROM resource_claims WHERE run_id = ? AND declared_path IS NOT NULL`, [runId])).toEqual([{ declared_path: "README.md" }]);
    });
    // Wrong target: the PLAN declared a branch the registered checkout is not on.
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      realWorkerRuntime(f);
      checkoutOn(f, WORK_BRANCH);
      const { owner, runId } = await dispatchedStandard(f, "std-wrong", { onDispatch: "follow-prompt", onContinuation: "ignore" }, "task/elsewhere");
      expect(toolsOf(owner.calls.filter((call) => call.runId === runId)).map(([tool]) => tool)).toEqual([
        "contract_get", "plan_submit", "contract_get", "task_worker_provision", "resource_claim", "task_worker_run", "escalation_open", "run_ack",
      ]);
      expect(owner.calls.find((call) => call.tool === "task_worker_run")).toMatchObject({ ok: false, reasonCode: ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH });
      expect(cp.tasks.executions(runId)).toEqual([]);
      expect(cp.db.all(`SELECT DISTINCT branch FROM resource_claims WHERE run_id = ? AND branch IS NOT NULL`, [runId])).toEqual([{ branch: "task/elsewhere" }]);
    });
  });
});

describe("review r1 probe 3, kept as written", () => {
  it("a continuation is neither stalled while running nor run after its final gate closes", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { runId, sessionId } = await stalledAfterPlan(f, "review-gate", "ignore");
      let release!: () => void;
      let entered = false;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const prepare = f.launch.prepare.bind(f.launch);
      vi.spyOn(f.launch, "prepare").mockImplementationOnce(async () => { entered = true; await barrier; return prepare(); });
      const turns = f.finishedTurns(sessionId);
      expect(f.daemon.wakeStandardWorkContinuation().woken).toHaveLength(1);
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
      expect(markers(f, STANDARD_WORK_CONTINUATION_STALLED, runId)).toEqual([]);
      expect(cp.runs.transition(runId, RunState.BLOCKED, "review hold").allowed).toBe(true);
      release();
      await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false));
      expect(f.finishedTurns(sessionId)).toBe(turns);
      expect(f.daemon.wakeStandardWorkContinuation()).toEqual(nothing);
    });
  });
});

/** c65e73b2's dispatch prompt, with only CEO bbc884ee's outcome-aware PLAN recovery amendment. */
const C65E73B2_DISPATCH_PROMPT_TAIL: readonly string[] = [
  "The control plane woke you for: in-band dispatch.",
  "Your only interface is the acp-cto tools. Call mcp__acp-cto__role_dispatch_pending to read the messages addressed to you.",
  "Act on each message as its kind requires, using the acp-cto tools, and acknowledge each one with mcp__acp-cto__run_ack (or mcp__acp-cto__role_dispatch_ack when it names no run).",
  "A RUN_DISPATCH for a run you own and have not yet submitted a PLAN for means: read mcp__acp-cto__contract_get for that run; write a PLAN that satisfies its contract, following the bootstrapPlanGuide it returns when there is one; submit the PLAN with mcp__acp-cto__plan_submit; use the same key for an identical retry. For MCP_REPLAY_UNVERIFIABLE or MCP_MUTATION_OUTCOME_UNKNOWN, recover a completed effect from durable state only when the durable effect matches THIS request (for PLAN, read contract_get and its tasks; the stored PLAN digest equals the digest of the PLAN this request would submit, and the tasks match this request); a mismatching or unprovable durable effect is not completion and is not proof of non-execution; allow a new request only with proof of non-execution; keep an uncertain outcome refused, with no automatic new key; an unclear refusal never authorizes resubmitting under a new key. Elapsed time, a missing response or an ordinary thrown error is not proof of non-execution. Only after proving non-execution, correct a refused PLAN from its evidence and submit the new request with a new key, at most 4 plan_submit calls for that run in this turn; then acknowledge the RUN_DISPATCH with mcp__acp-cto__run_ack.",
  "For a run whose contract_get returned a bootstrapPlanGuide, once its PLAN is accepted and the run is ACTIVE, unless that PLAN's result was already submitted, and before you acknowledge its RUN_DISPATCH: submit the result of its current PLAN with mcp__acp-cto__result_submit, its resultSummary and recommendation taken from that PLAN and a new idempotencyKey; result_submit runs the blind review itself and answers when it is done. Do not provision a worker or submit a task receipt for that run: its task is settled by the control plane at CEO CONFIRM.",
  "A REVISION_REQUEST for a run whose contract_get returned a bootstrapPlanGuide carries why its PLAN was sent back (the CEO's rationale, or the blind review's findings): for that run, read mcp__acp-cto__contract_get for that run; write a PLAN that satisfies its contract, following the bootstrapPlanGuide it returns when there is one; submit the PLAN with mcp__acp-cto__plan_submit; use the same key for an identical retry. For MCP_REPLAY_UNVERIFIABLE or MCP_MUTATION_OUTCOME_UNKNOWN, recover a completed effect from durable state only when the durable effect matches THIS request (for PLAN, read contract_get and its tasks; the stored PLAN digest equals the digest of the PLAN this request would submit, and the tasks match this request); a mismatching or unprovable durable effect is not completion and is not proof of non-execution; allow a new request only with proof of non-execution; keep an uncertain outcome refused, with no automatic new key; an unclear refusal never authorizes resubmitting under a new key. Elapsed time, a missing response or an ordinary thrown error is not proof of non-execution. Only after proving non-execution, correct a refused PLAN from its evidence and submit the new request with a new key, at most 4 plan_submit calls for that run in this turn, writing the new PLAN so that it addresses that reason; then acknowledge the REVISION_REQUEST with mcp__acp-cto__run_ack. If the run is ACTIVE, submit the new PLAN's result first, as above; a run the CEO sent back is ACTIVE again with its next RUN_DISPATCH.",
  "An ESCALATION_REPLY is the CEO's resolution of the escalation it names (its escalationId) for a run you are the current owner of: act on it only when it is addressed to you as that run's current owner and names that run's escalation, and then only for that run. Carry out its resolution, for example by planning that run again or submitting its result again as the lines above direct, then acknowledge the ESCALATION_REPLY with mcp__acp-cto__run_ack. The resolution never bypasses T3, the blind review or the CEO's CONFIRM: a new PLAN still goes through mcp__acp-cto__plan_submit and a result through mcp__acp-cto__result_submit, each with its normal gates. If carrying out the resolution fails or is refused, do not acknowledge it: report the refusal or failure for that run with mcp__acp-cto__escalation_open instead.",
  "A HANDOFF_PACKAGE is accepted with mcp__acp-cto__handoff_ack for its handoffId before it is acknowledged.",
  "When nothing addressed to you remains, reply with a one-line summary of what you did.",
];

/** The driven RUN_DISPATCH prompt c65e73b2 wrote for this holder: its first line, then the frozen rest. */
const c65e73b2DispatchPrompt = (firstLine: string): string => [firstLine, ...C65E73B2_DISPATCH_PROMPT_TAIL, frontierReviewPolicy()].join("\n");
const withoutAdministrativeTeaching = (prompt:string): string => prompt.split("\n").filter(line => !line.startsWith("For an administrative CONTRACT_CHANGE")).join("\n").replace("The resolution never bypasses the blind review", "The resolution never bypasses T3, the blind review");

/** ACP1195 input delivery is a separate amendment; all other dispatch/revision bytes stay frozen. */
const BOOTSTRAP_PLAN_INPUT_AMENDMENT = "if it carries bootstrapPlanDigest, read mcp__acp-cto__bootstrap_plan_get and submit that digest with runId and idempotencyKey, without plan or tasks; otherwise ";
const withoutBootstrapPlanInputAmendment = (prompt: string): string => {
  const lines = prompt.split("\n").filter(line => line.startsWith("A RUN_DISPATCH ") || line.startsWith("A REVISION_REQUEST "));
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line.split(BOOTSTRAP_PLAN_INPUT_AMENDMENT)).toHaveLength(2);
  expect(prompt.split(BOOTSTRAP_PLAN_INPUT_AMENDMENT)).toHaveLength(3);
  return prompt.replaceAll(BOOTSTRAP_PLAN_INPUT_AMENDMENT, "");
};

/** Re-enters the owner as a continuation's wake would: the turn carries that wake's line, and the stand-in remembers no id. */
const reenter = async (f: BootstrapRuntimeFixture, run: { runId: string; roleKey: string; sessionId: string; taskId: string }, id: string) => {
  const turns = f.finishedTurns(run.sessionId);
  expect(f.harness.cp.sessionRuntime.wake(run.roleKey, [{ id, kind: standardWorkContinuationTriggerKind(run.runId, run.taskId) }]).allowed).toBe(true);
  return turns;
};

describe("R1-01, CEO 07b5b0df — re-entry takes every task by its execution's state, from the record alone", () => {
  type Case = {
    /** What the record holds for the run's one task when the owner re-enters. */
    state: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | "ABANDONED";
    /** The clauses of the prompt the case rests on, asserted word for word before the behaviour. */
    clauses: string[];
    tools: string[];
    result: boolean;
  };
  const cases: Case[] = [
    { state: "RUNNING", clauses: [CLAUSE.everyTask, CLAUSE.readNewest, CLAUSE.untilSettled, CLAUSE.succeededDone, CLAUSE.result],
      tools: ["contract_get", "task_execution_get", "result_submit"], result: true },
    { state: "SUCCEEDED", clauses: [CLAUSE.everyTask, CLAUSE.readNewest, CLAUSE.succeededDone, CLAUSE.result],
      tools: ["contract_get", "task_execution_get", "result_submit"], result: true },
    { state: "FAILED", clauses: [CLAUSE.everyTask, CLAUSE.readNewest, CLAUSE.failedEscalate],
      tools: ["contract_get", "task_execution_get", "escalation_open"], result: false },
    { state: "TIMEOUT", clauses: [CLAUSE.everyTask, CLAUSE.readNewest, CLAUSE.failedEscalate],
      tools: ["contract_get", "task_execution_get", "escalation_open"], result: false },
    { state: "ABANDONED", clauses: [CLAUSE.everyTask, CLAUSE.readNewest, CLAUSE.failedEscalate],
      tools: ["contract_get", "task_execution_get", "escalation_open"], result: false },
  ];
  it.each(cases)("an execution $state when the owner re-enters, its id kept nowhere but the record: read by that id; $tools", async ({ state, clauses, tools, result }) => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const submit = vi.spyOn(cp.pipeline, "submitResult").mockResolvedValue(
        allow(ReasonCode.OK, { stage: "STAND_IN" }) as unknown as Awaited<ReturnType<typeof cp.pipeline.submitResult>>,
      );
      const real = realWorkerRuntime(f);
      const run = await stalledAfterPlan(f, `std-state-${state.toLowerCase()}`, "follow-prompt");
      const { owner, runId, sessionId, taskId } = run;
      const worker = bindRunWorker(f, runId, taskId);
      const opened = cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: 1, workerSessionId: worker.sessionId, provider: "claude", model: "opus" });
      if (!opened.allowed) throw new Error(opened.message);
      if (state !== "RUNNING") {
        const outcome = state === "SUCCEEDED"
          ? { status: "SUCCEEDED" as const, resultDigest: "sha256:settled" }
          : { status: state, failureClass: "unknown_observed" as const };
        const closed = cp.tasks.finishExecution(opened.value.executionId, outcome, runId);
        if (!closed.allowed) throw new Error(closed.message);
      }
      const turns = await reenter(f, run, `re-entry-${state}`);
      if (state === "RUNNING") {
        // Observed while it runs, then it settles: the owner keeps reading until it has.
        await vi.waitFor(() => expect(owner.calls.some((call) => call.tool === "task_execution_get" && call.ok)).toBe(true), { timeout: 10_000, interval: 10 });
        const closed = cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:settled" }, runId);
        if (!closed.allowed) throw new Error(closed.message);
      }
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await idle(f, sessionId);
      expect(toolsOf(owner.calls.slice(3)).map(([tool]) => tool)).toEqual(tools);
      // The behaviour rests on the prompt's own words: each clause it follows is there, word for word.
      const directive = owner.prompts.at(-1)!.split("\n").find((line) => line.startsWith(STANDARD_DIRECTIVE)) ?? "";
      for (const clause of clauses) expect(directive).toContain(clause);
      expect(owner.calls.filter((call) => call.tool === "task_execution_get").every((call) => call.ok)).toBe(true);
      // Never run again, never provisioned: the one execution stays the task's only one.
      expect(real.provision).not.toHaveBeenCalled();
      expect(real.start).not.toHaveBeenCalled();
      expect(cp.tasks.executions(runId).map((execution) => execution.executionId)).toEqual([opened.value.executionId]);
      expect(submit).toHaveBeenCalledTimes(result ? 1 : 0);
    });
  });

  it.each([
    { worker: false, tools: ["contract_get", "task_worker_provision", "resource_claim", "task_worker_run", "task_execution_get", "escalation_open"], provisions: 1 },
    { worker: true, tools: ["contract_get", "resource_claim", "task_worker_run", "task_execution_get", "escalation_open"], provisions: 0 },
  ])("a READY task with no execution (worker provisioned before: $worker) gets its first execution on the real runner, staffed only when it has no worker", async ({ worker, tools, provisions }) => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const real = realWorkerRuntime(f);
      // #512 S-TB (c98ea8a3): the control plane makes the declared branch at the run's pinned base; a branch
      // pre-created by anyone else is refused, so the checkout stays on the run's base branch here.
      const run = await stalledAfterPlan(f, `std-first-${String(worker)}`, "follow-prompt");
      const { owner, runId, sessionId, taskId } = run;
      if (worker) bindRunWorker(f, runId, taskId);
      const turns = await reenter(f, run, `first-${String(worker)}`);
      await f.awaitFinishedTurns(sessionId, turns + 1);
      await idle(f, sessionId);
      // The double launches no worker process, so the first execution ends FAILED, and is escalated.
      expect(toolsOf(owner.calls.slice(3)).map(([tool]) => tool)).toEqual(tools);
      const directive = owner.prompts.at(-1)!.split("\n").find((line) => line.startsWith(STANDARD_DIRECTIVE)) ?? "";
      for (const clause of [CLAUSE.everyTask, CLAUSE.firstExecution, worker ? CLAUSE.reuseWorker : CLAUSE.provision, CLAUSE.claim, CLAUSE.run, CLAUSE.readReturned]) {
        expect(directive).toContain(clause);
      }
      expect(real.provision).toHaveBeenCalledTimes(provisions);
      expect(cp.tasks.executions(runId)).toEqual([expect.objectContaining({ runtimeManaged: true, status: "FAILED" })]);
    });
  });
});

describe("R2-01, CEO 07b5b0df — bootstrap and CONTRACT_CHANGE keep c65e73b2 dispatch with CEO bbc884ee recovery", () => {
  it("a driven CONTRACT_CHANGE owner's dispatch prompt, and the bootstrap CTO's, carry CEO bbc884ee's recovery amendment; the other bytes stay frozen; the CONTRACT_CHANGE owner does what that prompt says and nothing more", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const real = realWorkerRuntime(f);
      checkoutOn(f, WORK_BRANCH);
      const { owner, runId, sessionId, bootstrapRunId } = await dispatchedStandard(
        f, "cc-regress", { onDispatch: "follow-prompt", onContinuation: "ignore" }, WORK_BRANCH, RunKind.CONTRACT_CHANGE,
      );
      expect(cp.runs.require(runId).kind).toBe(RunKind.CONTRACT_CHANGE);
      // What c65e73b2's prompt says, and nothing more: plan, acknowledge. No record read, no worker.
      expect(owner.calls.filter((call) => call.runId === runId).map((call) => [call.tool, call.ok])).toEqual([
        ["contract_get", true],
        ["plan_submit", true],
        ["run_ack", true],
      ]);
      // The CONTRACT_CHANGE run's RUN_DISPATCH turn: c65e73b2's prompt, byte for byte.
      expect((await f.cto(sessionId, "contract_get", { runId }))["value"]).not.toHaveProperty("bootstrapPlanDigest");
      expect(withoutBootstrapPlanInputAmendment(withoutAdministrativeTeaching(owner.prompts.at(-1)!))).toBe(c65e73b2DispatchPrompt("You are the PRIMARY_CTO in the agent control plane, at binding generation 1."));
      expect(real.provision).not.toHaveBeenCalled();
      expect(cp.tasks.executions(runId)).toEqual([]);
      expect(cp.tasks.list(runId).map((task) => task.state)).toEqual([TaskState.READY]);
      // A stored PLAN exposes its tasks for outcome reconciliation.
      expect((await f.cto(sessionId, "contract_get", { runId }))["value"]).toMatchObject({ tasks: [{ title: "update README.md", state: "READY" }] });
      // The project's bootstrap run's BOOTSTRAP_CTO dispatch turn, on the same double: c65e73b2's too.
      const bootstrapPrompt = f.claude.turns.find((turn) =>
        turn.relay !== null && turn.prompt.startsWith(`You are the BOOTSTRAP_CTO of run ${bootstrapRunId} `))!.prompt;
      expect(withoutBootstrapPlanInputAmendment(withoutAdministrativeTeaching(bootstrapPrompt!))).toBe(c65e73b2DispatchPrompt(`You are the BOOTSTRAP_CTO of run ${bootstrapRunId} in the agent control plane, at binding generation 1.`));
    });
  });
});

describe("witness 4 — duplicates and wrong targets are never woken", () => {
  // Updated for CEO e64aa10b (R1-01 b): a task whose worker was provisioned and never ran is no longer
  // excluded (it resumes on the same owner, witnessed below); a running or settled execution still is.
  it("a task already running or executed: no continuation, no blocker, no second provision", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const standIn = standInWorkerRuntime(f);
      const { runId, taskId } = await stalledAfterPlan(f, "std-dup", "follow-prompt");
      const workerSessionId = bindWorkerForTask(cp, taskId, { provider: "claude", model: "opus" });
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
