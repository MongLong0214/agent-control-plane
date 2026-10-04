import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { allow, deny, isAcpError, type Decision, type Evidence } from "../core/errors.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { type FailureClass, Role, SessionLifecycle, TaskState, roleKeyFor } from "../domain/types.ts";
import { git } from "../git/git.ts";
import { type ManagedWriteGuard, WriteOperation } from "../guard/managed-write-guard.ts";
import { canonical } from "../guard/workspace-probe.ts";
import type { InvocationResult, ProviderAdapter } from "../runtime/provider.ts";
import type { ExecutionRecord, TaskGraph } from "./task-graph.ts";

/**
 * #512 — the control plane runs one worker turn for a task the CTO chose.
 *
 * The CTO decides which task runs and when (PRD §8.3, §14.4); the control plane owns the lifecycle,
 * the receipts and the evidence (§8.6, §25.2). So `task_worker_run` hands this runner three names —
 * run, task, claim — and everything else is read from durable facts: the task's live WORKER binding
 * and the session its actor serves now, and the claim's worktree, branch and owned paths.
 *
 * The success order is fixed: the provider edits → the change is observed twice and must not move
 * between the two → the run's authority is re-checked through the Managed Write Guard → the control
 * plane commits exactly the observed paths → the commit is checked against the observation → only
 * then is the execution finished SUCCEEDED, with a digest bound to that commit's HEAD. Nothing is
 * ever reset or cleaned: a failure leaves every byte where the turn left it.
 */

/** A worker turn may not be asked to run longer than this (#512). */
export const WORKER_TURN_MAX_TIMEOUT_MS = 30 * 60 * 1000;
/** The worker runtime this path launches: a Claude session on Opus, nothing else. */
export const WORKER_TURN_PROVIDER = "claude";
export const WORKER_TURN_MODEL = "opus";

const DEFAULT_POLL_MS = 1_000;
const CONTROL_PLANE_COMMITTER = ["-c", "user.name=agent-control-plane", "-c", "user.email=agent-control-plane@localhost.invalid"];
/** Every git call this runner makes: no hooks, no fsmonitor, no signing prompt. */
const HARDENED = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false"];

/** Audit kinds this runner writes; `describe` reads them back. */
export const WorkerTurnEvent = {
  STARTED: "TASK_WORKER_TURN_STARTED",
  SUCCEEDED: "TASK_WORKER_TURN_SUCCEEDED",
  FAILED: "TASK_WORKER_TURN_FAILED",
  LATE_RESULT_REFUSED: "TASK_WORKER_TURN_LATE_RESULT_REFUSED",
  ORPHAN_KILLED: "TASK_WORKER_ORPHAN_KILLED",
  ORPHAN_GONE: "TASK_WORKER_ORPHAN_GONE",
  ORPHAN_UNIDENTIFIED: "TASK_WORKER_ORPHAN_UNIDENTIFIED",
} as const;

export interface WorkerTurnRequest {
  runId: string;
  taskId: string;
  claimId: string;
  timeoutMs?: number;
  /** The run owner the MCP owner fence authenticated — never a payload value. */
  ownerSessionId: string;
  ownerBindingGeneration: number;
}

/** One changed path, as the worktree holds it. A deletion has neither mode nor content. */
export interface WorkerDiffEntry {
  path: string;
  mode: "100644" | "100755" | "120000" | null;
  /** sha256 of the file's bytes (a symlink's target), null for a deletion. */
  sha256: string | null;
  /** The git object id the same bytes have, used to check the commit; not part of the digest. */
  blob: string | null;
}

/** What a success digest commits to; every input is written to the audit record beside it. */
export interface WorkerSuccessDigestInputs {
  executionId: string;
  workerSessionId: string;
  sessionIncarnation: string;
  providerSessionId: string;
  exitCode: number;
  stdoutSha256: string;
  commitHead: string;
  diffDigest: string;
}

/** The digest of a worker's change: base commit plus each changed path's mode and content hash. */
export const workerDiffDigest = (baseHead: string, entries: readonly WorkerDiffEntry[]): string =>
  digestOf({
    schema: "agent-control-plane.worker-diff.v1",
    baseHead,
    entries: [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => ({ path: entry.path, mode: entry.mode, sha256: entry.sha256 })),
  });

/** The finished receipt's digest; recomputable from the audit record's inputs alone. */
export const workerSuccessDigest = (inputs: WorkerSuccessDigestInputs): string =>
  digestOf({ schema: "agent-control-plane.worker-turn-success.v1", ...inputs });

/** How the runner reaches the OS processes it launched. Injectable so a restart can be simulated. */
export interface WorkerProcessPort {
  /** The OS start time of a live pid, read from the process; null when it cannot be read. */
  startToken(pid: number): string | null;
  alive(pid: number): boolean;
  /** Whether any process remains in the group the worker led. */
  groupAlive(pid: number): boolean;
  killGroup(pid: number): void;
}

const signalable = (target: number): boolean => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

export const osWorkerProcesses: WorkerProcessPort = {
  startToken: (pid) => readProcessStartToken(pid),
  alive: (pid) => signalable(pid),
  groupAlive: (pid) => signalable(-pid),
  killGroup: (pid) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  },
};

/** The control plane's commit of a verified change. Injectable so a failing commit can be measured. */
export interface WorkerCommitPort {
  commit(worktree: string, paths: readonly string[], message: string): Promise<Decision<string>>;
}

/** Stages exactly `paths`, refuses if the index then holds anything else, and commits. */
export const gitWorkerCommit: WorkerCommitPort = {
  commit: async (worktree, paths, message) => {
    const added = await git(worktree, [...HARDENED, "--literal-pathspecs", "add", "-A", "--", ...paths], { allowFailure: true });
    if (added.exitCode !== 0) {
      return deny(ReasonCode.INTERNAL_ERROR, "git add of the verified paths failed", {
        exitCode: added.exitCode,
        error: added.stderr.slice(0, 500),
      });
    }
    const staged = await git(worktree, [...HARDENED, "diff", "--cached", "--no-renames", "--name-only", "-z"], { allowFailure: true });
    const stagedPaths = staged.stdout.split("\0").filter(Boolean).sort();
    const expected = [...paths].sort();
    if (staged.exitCode !== 0 || stagedPaths.join("\0") !== expected.join("\0")) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the index holds something other than the verified paths", {
        paths: stagedPaths,
        expected,
      });
    }
    const committed = await git(
      worktree,
      [...HARDENED, ...CONTROL_PLANE_COMMITTER, "commit", "--no-verify", "--no-gpg-sign", "-q", "-m", message],
      { allowFailure: true },
    );
    if (committed.exitCode !== 0) {
      return deny(ReasonCode.INTERNAL_ERROR, "git commit failed", {
        exitCode: committed.exitCode,
        error: committed.stderr.slice(0, 500),
      });
    }
    const head = await git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFailure: true });
    if (head.exitCode !== 0) return deny(ReasonCode.INTERNAL_ERROR, "the new HEAD cannot be read", {});
    return allow(ReasonCode.OK, head.stdout.trim());
  },
};

export interface WorkerTurnOptions {
  /** How often an in-flight turn re-reads its execution, so a cancel or takeover stops the child. */
  pollMs?: number;
  processes?: WorkerProcessPort;
  commit?: WorkerCommitPort;
  /**
   * Test seam: runs after the turn's change has been observed and every check on it passed, and
   * before the commit's authority is re-checked — where a concurrent writer would land.
   */
  beforeCommit?: () => void | Promise<void>;
}

/** Ports the runner needs; the composition root supplies them, none is a service it could misuse. */
export interface WorkerTurnPorts {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  tasks: TaskGraph;
  guard: ManagedWriteGuard;
  /** The adapter that serves the WORKER role for the Claude provider. */
  workerAdapter: () => ProviderAdapter;
}

interface WorkerIdentity {
  roleKey: string;
  sessionId: string;
  incarnation: string;
  generation: number;
  externalSessionId: string;
}

interface ClaimFacts {
  claimId: string;
  repositoryId: string;
  repositoryIdentity: string;
  worktree: string;
  branch: string;
  ownedPaths: string[];
}

interface TurnFacts {
  runId: string;
  taskId: string;
  taskTitle: string;
  taskSpec: unknown;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  worker: WorkerIdentity;
  claim: ClaimFacts;
  baseHead: string;
  objectFormat: "sha1" | "sha256";
  gitDirs: string[];
  gitControlDigest: string;
}

type CommitOutcome =
  | { ok: true; head: string }
  | { ok: false; reason: string; reasonCode: ReasonCode; message: string; head: string | null; failureClass: FailureClass };

/** What the worktree shows after a turn, or why it could not be read safely. */
interface Observation {
  problem: { reason: string; reasonCode: ReasonCode; message: string } | null;
  entries: WorkerDiffEntry[];
  diffDigest: string | null;
  outOfScope: string[];
  /** Agent configuration the turn touched (`isAgentConfiguration`); always out of scope as well. */
  agentConfiguration: string[];
}

/**
 * #512 — files a later turn's CLI would load as configuration: anything under a `.claude` directory
 * (settings, settings.local, agents, commands, hooks) and the project MCP config at the repository
 * root. A WORKER's change to one is never committed, whatever the claim owns: committed, it would
 * grant the next WORKER turn what this one was not given — Bash in its permission rules, an MCP server.
 */
export const isAgentConfiguration = (path: string): boolean =>
  path === ".mcp.json" || path.split("/").includes(".claude");

/** Repository-root agent configuration git does not track, ignored files included. */
const untrackedAgentConfiguration = async (worktree: string): Promise<string[]> => {
  const listed = await git(
    worktree,
    [...HARDENED, "--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ".claude", ".mcp.json"],
    { allowFailure: true },
  );
  if (listed.exitCode !== 0) throw new Error("the worktree's untracked agent configuration cannot be listed");
  return listed.stdout.split("\0").filter(Boolean);
};

export interface WorkerExecutionView {
  execution: {
    executionId: string;
    runId: string;
    taskId: string;
    attempt: number;
    status: ExecutionRecord["status"];
    runtimeManaged: boolean;
    workerSessionId: string;
    workerProcessId: number | null;
    workerProcessStartedAt: string | null;
    worktreeId: string | null;
    startedAt: string;
    endedAt: string | null;
    failureClass: FailureClass | null;
  };
  /** Present only for a SUCCEEDED execution: its digest and the inputs it was computed from. */
  success: { resultDigest: string; inputs: Evidence | null } | null;
  /** The latest diagnostic record for an execution that did not succeed. Never a success digest. */
  diagnostics: { kind: string; evidence: Evidence } | null;
}

const insideOwned = (path: string, owned: readonly string[]): boolean =>
  owned.some((root) => root === "." || path === root || path.startsWith(`${root}/`));

const gitBlobId = (format: "sha1" | "sha256", bytes: Buffer): string =>
  createHash(format).update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

const errorText = (error: unknown): string =>
  isAcpError(error) ? `${error.reasonCode}: ${error.message}` : error instanceof Error ? error.message : String(error);

export class WorkerTurnRunner {
  readonly #turns = new Map<string, Promise<void>>();
  readonly #busyWorktrees = new Set<string>();
  readonly #pollMs: number;
  readonly #processes: WorkerProcessPort;
  readonly #commit: WorkerCommitPort;
  readonly #beforeCommit: (() => void | Promise<void>) | undefined;

  constructor(private readonly ports: WorkerTurnPorts, options: WorkerTurnOptions = {}) {
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#processes = options.processes ?? osWorkerProcesses;
    this.#commit = options.commit ?? gitWorkerCommit;
    this.#beforeCommit = options.beforeCommit;
  }

  /**
   * Starts one worker turn and returns its execution id at once; the turn runs on.
   *
   * Refused before anything is recorded when a durable fact does not hold — and refused, not
   * repaired, when the claimed worktree is not clean: a previous attempt's preserved bytes or
   * another writer's are never reset, cleaned or folded into this turn (#512).
   */
  async start(request: WorkerTurnRequest): Promise<Decision<{ executionId: string }>> {
    const timeoutMs = Math.min(request.timeoutMs ?? WORKER_TURN_MAX_TIMEOUT_MS, WORKER_TURN_MAX_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a worker turn timeout must be a positive number of milliseconds", {
        timeoutMs: request.timeoutMs ?? null,
      });
    }
    const durable = this.readFacts(request);
    if (!durable.allowed) return durable as Decision<{ executionId: string }>;
    const facts = durable.value;
    let adapter: ProviderAdapter;
    try {
      adapter = this.ports.workerAdapter();
    } catch (error) {
      return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "no worker runtime is registered for this deployment", {
        provider: WORKER_TURN_PROVIDER,
        error: errorText(error).slice(0, 300),
      });
    }
    const worktree = facts.claim.worktree;
    if (this.#busyWorktrees.has(worktree)) {
      return deny(ReasonCode.CONFLICT, "the claimed worktree already has a worker turn in flight", { worktreeId: worktree });
    }
    this.#busyWorktrees.add(worktree);
    let launched = false;
    try {
      const prepared = await this.prepareWorktree(facts);
      if (!prepared.allowed) return prepared as Decision<{ executionId: string }>;
      const turn = prepared.value;
      const started = await this.ports.tasks.startWorkerExecution({
        runId: turn.runId,
        taskId: turn.taskId,
        ownerBindingGeneration: turn.ownerBindingGeneration,
        workerSessionId: turn.worker.sessionId,
        provider: WORKER_TURN_PROVIDER,
        model: WORKER_TURN_MODEL,
        repositoryId: turn.claim.repositoryId,
        worktreeId: worktree,
        concurrencyWidth: this.ports.tasks.runningWidth(turn.runId) + 1,
        runtimeManaged: true,
      });
      if (!started.allowed) return started as Decision<{ executionId: string }>;
      const executionId = started.value.executionId;
      this.ports.audit.record({
        kind: WorkerTurnEvent.STARTED,
        runId: turn.runId,
        sessionId: turn.worker.sessionId,
        roleKey: turn.worker.roleKey,
        evidence: {
          executionId,
          taskId: turn.taskId,
          claimId: turn.claim.claimId,
          worktreeId: worktree,
          branch: turn.claim.branch,
          paths: turn.claim.ownedPaths,
          head: turn.baseHead,
          generation: turn.worker.generation,
          timeoutMs,
        },
      });
      launched = true;
      const running = this.execute(adapter, turn, executionId, timeoutMs).finally(() => {
        this.#busyWorktrees.delete(worktree);
        this.#turns.delete(executionId);
      });
      this.#turns.set(executionId, running);
      return allow(ReasonCode.OK, { executionId });
    } finally {
      if (!launched) this.#busyWorktrees.delete(worktree);
    }
  }

  /** Resolves when the turn for `executionId` has finished, however it finished. Test and stop seam. */
  async settled(executionId: string): Promise<void> {
    await this.#turns.get(executionId);
  }

  /** Read-only: an execution's state, with diagnostics kept apart from the success digest. */
  describe(executionId: string, runId: string): Decision<WorkerExecutionView> {
    const execution = this.ports.tasks.execution(executionId);
    if (!execution) return deny(ReasonCode.NOT_FOUND, "unknown execution", { executionId });
    const task = this.ports.tasks.get(execution.taskId);
    if (execution.runId !== runId || !task || task.runId !== runId) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "execution belongs to another run", {
        executionId,
        executionRunId: execution.runId,
        requestedRunId: runId,
      });
    }
    const events = this.eventsFor(execution.runId, executionId);
    const succeeded = events.filter((event) => event.kind === WorkerTurnEvent.SUCCEEDED).at(-1) ?? null;
    const diagnostic = events
      .filter((event) => event.kind !== WorkerTurnEvent.STARTED && event.kind !== WorkerTurnEvent.SUCCEEDED)
      .at(-1) ?? null;
    return allow(ReasonCode.OK, {
      execution: {
        executionId: execution.executionId,
        runId: execution.runId,
        taskId: execution.taskId,
        attempt: execution.attempt,
        status: execution.status,
        runtimeManaged: execution.runtimeManaged,
        workerSessionId: execution.workerSessionId,
        workerProcessId: execution.workerProcessId,
        workerProcessStartedAt: execution.workerProcessStartedAt,
        worktreeId: execution.worktreeId,
        startedAt: execution.startedAt,
        endedAt: execution.endedAt,
        failureClass: execution.failureClass,
      },
      success:
        execution.status === "SUCCEEDED" && execution.resultDigest
          ? { resultDigest: execution.resultDigest, inputs: succeeded?.evidence ?? null }
          : null,
      diagnostics: execution.status === "SUCCEEDED" || !diagnostic ? null : diagnostic,
    });
  }

  /**
   * Startup reconciliation for runtime-managed executions still RUNNING (#512). Nothing is ever
   * re-invoked. A recorded worker is killed only when its pid, the OS start time read from that pid
   * now, and this execution's ownership of the pair all match; an identification that is not certain
   * kills nothing, and the task is then blocked from another turn while that process may live.
   */
  reconcileAfterRestart(): Array<{ executionId: string; outcome: "KILLED" | "GONE" | "NEVER_LAUNCHED" | "UNIDENTIFIED" }> {
    const rows = this.ports.db.all<{
      execution_id: string;
      run_id: string;
      task_id: string;
      worker_session_id: string;
      worker_process_id: number | null;
      worker_process_started_at: string | null;
    }>(
      `SELECT execution_id, run_id, task_id, worker_session_id, worker_process_id, worker_process_started_at
         FROM task_executions WHERE status = 'RUNNING' AND runtime_managed = 1 ORDER BY execution_id`,
    );
    const outcomes: Array<{ executionId: string; outcome: "KILLED" | "GONE" | "NEVER_LAUNCHED" | "UNIDENTIFIED" }> = [];
    for (const row of rows) {
      const pid = row.worker_process_id;
      const recorded = row.worker_process_started_at;
      let outcome: "KILLED" | "GONE" | "NEVER_LAUNCHED" | "UNIDENTIFIED";
      let observed: string | null = null;
      if (pid === null) {
        outcome = this.launchWasAuthorised(row.execution_id) ? "UNIDENTIFIED" : "NEVER_LAUNCHED";
      } else if (!this.#processes.alive(pid) && !this.#processes.groupAlive(pid)) {
        outcome = "GONE";
      } else {
        observed = this.#processes.alive(pid) ? this.#processes.startToken(pid) : null;
        const sharedWithAnother = this.ports.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM task_executions
            WHERE worker_process_id = ? AND worker_process_started_at IS ? AND execution_id <> ?
              AND status = 'RUNNING'`,
          [pid, recorded, row.execution_id],
        )?.n ?? 0;
        const owned = recorded !== null && observed !== null && observed === recorded && sharedWithAnother === 0;
        if (owned) {
          this.#processes.killGroup(pid);
          outcome = "KILLED";
        } else {
          outcome = "UNIDENTIFIED";
        }
      }
      const finished = this.ports.tasks.finishExecution(
        row.execution_id,
        { status: "ABANDONED", failureClass: "infrastructure" },
        row.run_id,
      );
      this.ports.audit.record({
        kind: outcome === "KILLED"
          ? WorkerTurnEvent.ORPHAN_KILLED
          : outcome === "UNIDENTIFIED"
            ? WorkerTurnEvent.ORPHAN_UNIDENTIFIED
            : WorkerTurnEvent.ORPHAN_GONE,
        runId: row.run_id,
        sessionId: row.worker_session_id,
        reasonCode: finished.allowed ? ReasonCode.OK : finished.reasonCode,
        evidence: {
          executionId: row.execution_id,
          taskId: row.task_id,
          status: "ABANDONED",
          reason: `restart found the runtime-managed execution RUNNING: ${outcome}`,
          pid,
          recordedStartedAt: recorded,
          observedStartedAt: observed,
          killed: outcome === "KILLED",
          reexecutionBlocked: outcome === "UNIDENTIFIED",
        },
      });
      outcomes.push({ executionId: row.execution_id, outcome });
    }
    return outcomes;
  }

  // -------------------------------------------------------------------------

  /** The durable facts of a turn: run, task, live WORKER identity and the claim. No caller value is trusted. */
  private readFacts(request: WorkerTurnRequest): Decision<Omit<TurnFacts, "baseHead" | "objectFormat" | "gitDirs" | "gitControlDigest">> {
    const { db } = this.ports;
    const run = db.get<{
      state: string;
      owner_session_id: string | null;
      owner_binding_generation: number | null;
    }>(`SELECT state, owner_session_id, owner_binding_generation FROM runs WHERE run_id = ?`, [request.runId]);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: request.runId });
    if (run.owner_session_id !== request.ownerSessionId || run.owner_binding_generation !== request.ownerBindingGeneration) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "the run's owner is no longer the caller", { runId: request.runId });
    }
    if (run.state !== "ACTIVE") {
      return deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, `run is ${run.state}; a worker turn needs an ACTIVE run`, {
        runId: request.runId,
        state: run.state,
      });
    }
    const task = db.get<{ run_id: string; title: string; spec_json: string; state: string }>(
      `SELECT run_id, title, spec_json, state FROM tasks WHERE task_id = ?`,
      [request.taskId],
    );
    if (!task) return deny(ReasonCode.NOT_FOUND, "unknown task", { taskId: request.taskId });
    if (task.run_id !== request.runId) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "task belongs to another run", {
        taskId: request.taskId,
        taskRunId: task.run_id,
        requestedRunId: request.runId,
      });
    }
    if (task.state === TaskState.SUCCEEDED) {
      return deny(ReasonCode.CONFLICT, "the task already succeeded; it is not executed again", { taskId: request.taskId });
    }
    const running = db.get<{ execution_id: string }>(
      `SELECT execution_id FROM task_executions WHERE task_id = ? AND status = 'RUNNING'`,
      [request.taskId],
    );
    if (running) {
      return deny(ReasonCode.CONFLICT, "the task already has a running execution", {
        taskId: request.taskId,
        executionId: running.execution_id,
      });
    }
    const blocked = this.blockedOrphan(request.taskId);
    if (blocked) {
      return deny(ReasonCode.CONFLICT, "an earlier turn of this task left a process that could not be identified; it is not executed again while that process may live", {
        taskId: request.taskId,
        executionId: blocked.executionId,
        pid: blocked.pid,
      });
    }

    const worker = this.liveWorker(request.runId, request.taskId);
    if (!worker.allowed) return worker as Decision<never>;
    const independent = this.assertIndependent(request, worker.value);
    if (!independent.allowed) return independent as Decision<never>;
    const claim = this.claimFacts(request);
    if (!claim.allowed) return claim as Decision<never>;
    let spec: unknown = {};
    try {
      spec = JSON.parse(task.spec_json) as unknown;
    } catch {
      spec = {};
    }
    return allow(ReasonCode.OK, {
      runId: request.runId,
      taskId: request.taskId,
      taskTitle: task.title,
      taskSpec: spec,
      ownerSessionId: request.ownerSessionId,
      ownerBindingGeneration: request.ownerBindingGeneration,
      worker: worker.value,
      claim: claim.value,
    });
  }

  /** The ACTIVE `WORKER:<taskId>` binding of this run and the READY Claude/Opus session its actor serves now. */
  private liveWorker(runId: string, taskId: string): Decision<WorkerIdentity> {
    const row = this.ports.db.get<{
      role_key: string;
      run_id: string | null;
      binding_generation: number;
      current_session_id: string | null;
      current_session_incarnation: string | null;
      lifecycle: string | null;
      provider: string | null;
      model: string | null;
      incarnation: string | null;
    }>(
      `SELECT a.role_key, a.run_id, a.binding_generation, c.current_session_id, c.current_session_incarnation,
              s.lifecycle, s.provider, s.model, s.incarnation
         FROM assignments a
         JOIN conversational_actors c ON c.actor_id = a.actor_id
         LEFT JOIN sessions s ON s.session_id = c.current_session_id
        WHERE a.role_key = ? AND a.role = 'WORKER' AND a.status = 'ACTIVE' AND a.task_id = ?`,
      [roleKeyFor(Role.WORKER, { taskId }), taskId],
    );
    if (!row) {
      return deny(ReasonCode.WORKER_BINDING_REQUIRED, "the task has no ACTIVE WORKER binding", { runId, taskId });
    }
    if (row.run_id !== runId) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the WORKER binding does not name this run", {
        runId,
        taskId,
      });
    }
    if (!row.current_session_id || !row.current_session_incarnation || row.lifecycle !== SessionLifecycle.READY) {
      return deny(ReasonCode.SESSION_NOT_READY, "the WORKER's live session is not READY", {
        taskId,
        sessionId: row.current_session_id,
        lifecycle: row.lifecycle,
      });
    }
    if (row.incarnation !== row.current_session_incarnation) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "the WORKER's live pointer names another incarnation", {
        taskId,
        sessionId: row.current_session_id,
      });
    }
    if (row.provider !== WORKER_TURN_PROVIDER || row.model !== WORKER_TURN_MODEL) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a worker turn runs on a Claude session with model opus", {
        taskId,
        provider: row.provider,
        model: row.model,
      });
    }
    return allow(ReasonCode.OK, {
      roleKey: row.role_key,
      sessionId: row.current_session_id,
      incarnation: row.current_session_incarnation,
      generation: row.binding_generation,
      externalSessionId: row.current_session_incarnation.split("#", 1)[0] ?? row.current_session_id,
    });
  }

  /** The implementer is a separate session: never the run owner's, never one holding another role. */
  private assertIndependent(request: WorkerTurnRequest, worker: WorkerIdentity): Decision<void> {
    const shared = this.ports.db.get<{ role_key: string }>(
      `SELECT o.role_key FROM assignments o
         LEFT JOIN conversational_actors oc ON oc.actor_id = o.actor_id
        WHERE o.status = 'ACTIVE' AND o.role <> 'WORKER'
          AND (o.session_id = ? OR oc.current_session_id = ?)
        ORDER BY o.role_key LIMIT 1`,
      [worker.sessionId, worker.sessionId],
    );
    if (worker.sessionId === request.ownerSessionId || shared) {
      return deny(
        ReasonCode.WORKER_SESSION_NOT_INDEPENDENT,
        "the WORKER's session is the run owner's or holds another role; the implementer must be a separate session",
        { taskId: request.taskId, sessionId: worker.sessionId, roleKey: shared?.role_key ?? null },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** The named HELD worktree claim of this run, with the branch and owned paths acquired with it. */
  private claimFacts(request: WorkerTurnRequest): Decision<ClaimFacts> {
    const { db, clock } = this.ports;
    const now = clock.nowIso();
    const claim = db.get<{
      run_id: string;
      repository_identity: string;
      worktree_id: string | null;
      owner_session_id: string;
      owner_binding_generation: number;
      acquired_at: string;
      status: string;
      expires_at: string;
    }>(
      `SELECT run_id, repository_identity, worktree_id, owner_session_id, owner_binding_generation,
              acquired_at, status, expires_at
         FROM resource_claims WHERE claim_id = ?`,
      [request.claimId],
    );
    if (!claim || claim.run_id !== request.runId) {
      return deny(ReasonCode.CLAIM_NOT_HELD, "the claim is not this run's", { claimId: request.claimId, runId: request.runId });
    }
    if (claim.status !== "HELD" || claim.expires_at <= now) {
      return deny(ReasonCode.CLAIM_NOT_HELD, "the claim is not held", { claimId: request.claimId, status: claim.status });
    }
    if (!claim.worktree_id) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a worker turn names the run's worktree claim", { claimId: request.claimId });
    }
    if (claim.owner_binding_generation !== request.ownerBindingGeneration) {
      return deny(ReasonCode.CLAIM_OWNER_GENERATION_REVOKED, "the claim was acquired under another owner generation", {
        claimId: request.claimId,
      });
    }
    const siblings = db.all<{ branch: string | null; declared_path: string | null }>(
      `SELECT branch, declared_path FROM resource_claims
        WHERE run_id = ? AND repository_identity = ? AND status = 'HELD' AND expires_at > ?
          AND owner_session_id = ? AND owner_binding_generation = ? AND acquired_at = ?
        ORDER BY claim_id`,
      [request.runId, claim.repository_identity, now, claim.owner_session_id, claim.owner_binding_generation, claim.acquired_at],
    );
    const branches = siblings.map((row) => row.branch).filter((branch): branch is string => branch !== null);
    const ownedPaths = [...new Set(siblings.map((row) => row.declared_path).filter((path): path is string => path !== null))].sort();
    if (branches.length !== 1) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the claim must hold exactly one branch", {
        claimId: request.claimId,
        branches,
      });
    }
    if (ownedPaths.length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the claim owns no paths, so nothing a worker writes could be committed", {
        claimId: request.claimId,
      });
    }
    const repository = db.get<{ repository_id: string; checkout_path: string }>(
      `SELECT r.repository_id, r.checkout_path
         FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id
        WHERE rr.run_id = ? AND r.identity = ?`,
      [request.runId, claim.repository_identity],
    );
    if (!repository) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the claim's repository does not participate in this run", {
        claimId: request.claimId,
        repositoryIdentity: claim.repository_identity,
      });
    }
    const worktree = canonical(claim.worktree_id);
    if (worktree !== canonical(repository.checkout_path)) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the claimed worktree is not the repository's registered checkout", {
        claimId: request.claimId,
        worktreeId: worktree,
      });
    }
    return allow(ReasonCode.OK, {
      claimId: request.claimId,
      repositoryId: repository.repository_id,
      repositoryIdentity: claim.repository_identity,
      worktree,
      branch: branches[0]!,
      ownedPaths,
    });
  }

  /**
   * The worktree a turn may start from: a live checkout on the claim's branch with nothing
   * uncommitted. Anything else is refused, never reset — on a retry this is what verifies that the
   * previous attempt's preserved state is safe to build on.
   */
  private async prepareWorktree(
    facts: Omit<TurnFacts, "baseHead" | "objectFormat" | "gitDirs" | "gitControlDigest">,
  ): Promise<Decision<TurnFacts>> {
    const worktree = facts.claim.worktree;
    try {
      const top = await git(worktree, ["rev-parse", "--show-toplevel"], { allowFailure: true });
      if (top.exitCode !== 0 || canonical(top.stdout.trim()) !== worktree) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the claimed worktree is not a live git work tree", { worktreeId: worktree });
      }
      const branch = await git(worktree, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true });
      if (branch.exitCode !== 0 || branch.stdout.trim() !== facts.claim.branch) {
        return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the claimed worktree is not on the claimed branch", {
          worktreeId: worktree,
          branch: facts.claim.branch,
          observed: branch.stdout.trim() || null,
        });
      }
      const status = await git(worktree, [...HARDENED, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { allowFailure: true });
      if (status.exitCode !== 0) {
        return deny(ReasonCode.PROBE_FAILED, "the claimed worktree's status cannot be read", { worktreeId: worktree });
      }
      if (status.stdout.length > 0) {
        return deny(
          ReasonCode.CONFLICT,
          "the claimed worktree holds uncommitted changes; a worker turn starts only from a clean tree, and the control plane never resets or cleans one",
          { worktreeId: worktree, paths: parseStatus(status.stdout).map((entry) => entry.path).slice(0, 50) },
        );
      }
      const head = await git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFailure: true });
      if (head.exitCode !== 0) return deny(ReasonCode.PROBE_FAILED, "the claimed worktree has no HEAD commit", { worktreeId: worktree });
      // `git status` does not show ignored files, and `.claude/settings.local.json` is usually ignored.
      // Left by an earlier turn, it would be loaded by this one's CLI (the `local` setting source), so a
      // turn starts only when the root's agent configuration is all tracked — never cleaned away here.
      const leftover = await untrackedAgentConfiguration(worktree);
      if (leftover.length > 0) {
        return deny(
          ReasonCode.CONFLICT,
          "the claimed worktree holds agent configuration git does not track; a worker turn would load it, and the control plane never removes it",
          { worktreeId: worktree, paths: leftover.slice(0, 50) },
        );
      }
      const format = await git(worktree, ["rev-parse", "--show-object-format"], { allowFailure: true });
      const objectFormat = format.stdout.trim() === "sha256" ? "sha256" : "sha1";
      const gitDir = await git(worktree, ["rev-parse", "--absolute-git-dir"], { allowFailure: true });
      const commonDir = await git(worktree, ["rev-parse", "--git-common-dir"], { allowFailure: true });
      if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) {
        return deny(ReasonCode.PROBE_FAILED, "the claimed worktree's git directory cannot be read", { worktreeId: worktree });
      }
      const common = commonDir.stdout.trim();
      const gitDirs = [...new Set([gitDir.stdout.trim(), isAbsolute(common) ? common : resolve(worktree, common)])];
      return allow(ReasonCode.OK, {
        ...facts,
        baseHead: head.stdout.trim(),
        objectFormat,
        gitDirs,
        gitControlDigest: gitControlDigest(gitDirs),
      });
    } catch (error) {
      return deny(ReasonCode.PROBE_FAILED, "the claimed worktree could not be inspected", {
        worktreeId: worktree,
        error: errorText(error).slice(0, 500),
      });
    }
  }

  private async execute(adapter: ProviderAdapter, facts: TurnFacts, executionId: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    let stopped = false;
    let spawned = false;
    let result: InvocationResult | null = null;
    let thrown: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // A cancel or takeover moves the execution off RUNNING from elsewhere; the child is stopped then,
    // not when the provider happens to finish.
    const poll = setInterval(() => {
      if (!this.isRunning(executionId)) {
        stopped = true;
        controller.abort();
      }
    }, this.#pollMs);
    try {
      result = await adapter.invoke({
        prompt: workerPrompt(facts),
        workdir: facts.claim.worktree,
        timeoutMs,
        model: WORKER_TURN_MODEL,
        readOnly: false,
        correlationId: executionId,
        externalSessionId: facts.worker.externalSessionId,
        managedWrite: {
          operation: WriteOperation.FILE_MUTATION,
          targetPath: facts.claim.worktree,
          taskId: facts.taskId,
          taskReceiptId: executionId,
          assignedWorktreeId: facts.claim.worktree,
          repositoryIdentity: facts.claim.repositoryIdentity,
          targetBranch: facts.claim.branch,
          runId: facts.runId,
          sessionId: facts.worker.sessionId,
          sessionIncarnation: facts.worker.incarnation,
          bindingGeneration: facts.worker.generation,
        },
        onSpawn: (pid, startedAt) => {
          spawned = true;
          const recorded = this.ports.tasks.recordWorkerProcess(executionId, pid, startedAt);
          // Throwing makes the adapter kill the child: a process this execution cannot record must not run.
          if (!recorded.allowed) throw new Error(`${recorded.reasonCode}: ${recorded.message}`);
        },
        signal: controller.signal,
      });
    } catch (error) {
      thrown = errorText(error);
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
    }

    try {
      await this.conclude(facts, executionId, { result, thrown, spawned, timedOut, stopped });
    } catch (error) {
      // The runner must leave a record even when its own evaluation fails; the bytes stay as they are.
      this.fail(facts, executionId, "FAILED", "infrastructure", {
        reason: "RUNNER_ERROR",
        reasonCode: ReasonCode.INTERNAL_ERROR,
        error: errorText(error),
        exitCode: result?.exitCode ?? null,
        stdoutSha256: result ? sha256(result.stdout ?? result.text) : null,
        diffDigest: null,
      });
    }
  }

  private async conclude(
    facts: TurnFacts,
    executionId: string,
    turn: { result: InvocationResult | null; thrown: string | null; spawned: boolean; timedOut: boolean; stopped: boolean },
  ): Promise<void> {
    const { result } = turn;
    const stdoutSha256 = result ? sha256(result.stdout ?? result.text) : null;
    const base = {
      exitCode: result?.exitCode ?? null,
      stdoutSha256,
      providerSessionId: result?.providerSessionId ?? null,
      spawned: turn.spawned,
      error: (result?.error ?? turn.thrown)?.slice(0, 500) ?? null,
    };
    // Observed for every outcome, so a failure keeps the digest of whatever the turn left behind.
    const observed = turn.spawned ? await this.observe(facts) : null;
    const diffDigest = observed?.diffDigest ?? null;
    const evidence = { ...base, diffDigest, paths: observed?.entries.map((entry) => entry.path) ?? [] };

    if (!this.isRunning(executionId)) {
      this.refuseLate(facts, executionId, { ...evidence, reason: "EXECUTION_NO_LONGER_RUNNING" });
      return;
    }
    if (turn.timedOut || result?.error === "timeout") {
      this.fail(facts, executionId, "TIMEOUT", "transient", { ...evidence, reason: "TIMEOUT", reasonCode: ReasonCode.INTERNAL_ERROR });
      return;
    }
    if (turn.thrown !== null || !result) {
      this.fail(facts, executionId, "FAILED", "infrastructure", { ...evidence, reason: "ADAPTER_THREW", reasonCode: ReasonCode.INTERNAL_ERROR });
      return;
    }
    if (!turn.spawned) {
      this.fail(facts, executionId, "FAILED", "infrastructure", { ...evidence, reason: "NEVER_RAN", reasonCode: ReasonCode.INTERNAL_ERROR });
      return;
    }
    if (!result.ok) {
      const exited = result.exitCode !== null && result.exitCode !== 0;
      this.fail(facts, executionId, "FAILED", exited ? "unknown_observed" : "policy", {
        ...evidence,
        reason: exited ? "EXIT_NONZERO" : "INVOCATION_REFUSED_AFTER_SPAWN",
        reasonCode: ReasonCode.INTERNAL_ERROR,
      });
      return;
    }
    if (result.providerSessionId !== facts.worker.externalSessionId) {
      this.fail(facts, executionId, "FAILED", "security", {
        ...evidence,
        reason: "SESSION_MISMATCH",
        reasonCode: ReasonCode.ISOLATION_LOST,
        expectedSession: facts.worker.externalSessionId,
      });
      return;
    }
    if (!observed || observed.problem) {
      this.fail(facts, executionId, "FAILED", "security", {
        ...evidence,
        reason: observed?.problem?.reason ?? "UNOBSERVED",
        reasonCode: observed?.problem?.reasonCode ?? ReasonCode.INTERNAL_ERROR,
        detail: observed?.problem?.message ?? null,
      });
      return;
    }
    if (observed.outOfScope.length > 0) {
      this.fail(facts, executionId, "FAILED", "contract", {
        ...evidence,
        reason: "OUT_OF_SCOPE",
        reasonCode: ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        uncovered: observed.outOfScope,
        agentConfiguration: observed.agentConfiguration,
      });
      return;
    }
    if (observed.entries.length === 0 || !observed.diffDigest) {
      this.fail(facts, executionId, "FAILED", "contract", { ...evidence, reason: "NO_CHANGE", reasonCode: ReasonCode.EVIDENCE_MISSING });
      return;
    }

    await this.#beforeCommit?.();
    const committed = await this.commitVerified(facts, executionId, observed);
    if (!committed.ok) {
      this.fail(facts, executionId, "FAILED", committed.failureClass, {
        ...evidence,
        reason: committed.reason,
        reasonCode: committed.reasonCode,
        detail: committed.message,
        commitHead: committed.head,
      });
      return;
    }

    // SUCCEEDED only now, after the commit, bound to its exact HEAD.
    const inputs: WorkerSuccessDigestInputs = {
      executionId,
      workerSessionId: facts.worker.sessionId,
      sessionIncarnation: facts.worker.incarnation,
      providerSessionId: result.providerSessionId!,
      exitCode: result.exitCode ?? 0,
      stdoutSha256: stdoutSha256!,
      commitHead: committed.head,
      diffDigest: observed.diffDigest,
    };
    const resultDigest = workerSuccessDigest(inputs);
    const finished = this.ports.tasks.finishExecution(executionId, { status: "SUCCEEDED", resultDigest }, facts.runId);
    if (!finished.allowed) {
      this.refuseLate(facts, executionId, {
        ...evidence,
        reason: "FINISH_REFUSED_AFTER_COMMIT",
        reasonCode: finished.reasonCode,
        commitHead: committed.head,
      });
      return;
    }
    this.ports.audit.record({
      kind: WorkerTurnEvent.SUCCEEDED,
      runId: facts.runId,
      sessionId: facts.worker.sessionId,
      roleKey: facts.worker.roleKey,
      evidence: {
        ...inputs,
        resultDigest,
        taskId: facts.taskId,
        head: facts.baseHead,
        paths: observed.entries.map((entry) => entry.path),
      },
    });
  }

  /**
   * Re-observes, re-checks authority through the guard, commits, and checks the commit. The commit
   * runs inside the guard's grant for a task-bound GIT_COMMIT, so the run owner's binding, the WORKER
   * binding, the live receipt and the claims are all re-read immediately before it and settled after.
   */
  private async commitVerified(facts: TurnFacts, executionId: string, first: Observation): Promise<CommitOutcome> {
    // A holder rather than a `let`: the effect below reassigns it, and a narrowed local would hide that.
    const state: { outcome: CommitOutcome } = {
      outcome: {
        ok: false,
        reason: "COMMIT_NOT_REACHED",
        reasonCode: ReasonCode.INTERNAL_ERROR,
        message: "the commit effect did not run",
        head: null,
        failureClass: "infrastructure",
      },
    };
    const paths = first.entries.map((entry) => entry.path).sort();
    const authorised = await this.ports.guard.authorize(
      {
        operation: WriteOperation.GIT_COMMIT,
        targetPath: facts.claim.worktree,
        repositoryIdentity: facts.claim.repositoryIdentity,
        targetBranch: facts.claim.branch,
        targetWorktreeId: facts.claim.worktree,
        assignedWorktreeId: facts.claim.worktree,
        taskId: facts.taskId,
        taskReceiptId: executionId,
        runId: facts.runId,
        sessionId: facts.worker.sessionId,
        sessionIncarnation: facts.worker.incarnation,
        bindingGeneration: facts.worker.generation,
        actor: "worker-turn",
      },
      async () => {
        const again = await this.observe(facts);
        if (again.problem || again.diffDigest !== first.diffDigest || again.outOfScope.length > 0) {
          state.outcome = {
            ok: false,
            reason: "DIFF_UNSTABLE",
            reasonCode: ReasonCode.WRITE_EFFECT_FENCE_LOST,
            message: again.problem?.message ?? "the worktree changed between the turn and the commit",
            head: null,
            failureClass: "security",
          };
          return;
        }
        const committed = await this.#commit.commit(facts.claim.worktree, paths, commitMessage(facts));
        if (!committed.allowed) {
          state.outcome = {
            ok: false,
            reason: "COMMIT_FAILED",
            reasonCode: committed.reasonCode,
            message: committed.message,
            head: null,
            failureClass: "infrastructure",
          };
          return;
        }
        const verified = await this.verifyCommit(facts, committed.value, first);
        state.outcome = verified.allowed
          ? { ok: true, head: committed.value }
          : {
              ok: false,
              reason: "COMMIT_MISMATCH",
              reasonCode: verified.reasonCode,
              message: verified.message,
              head: committed.value,
              failureClass: "security",
            };
      },
    );
    const outcome = state.outcome;
    if (!authorised.allowed) {
      // The guard refused before the effect (authority lost) or after it (settle denied). A commit
      // that exists by then is not success: it is reported with its HEAD, and its bytes stay put.
      return {
        ok: false,
        reason: outcome.head !== null
          ? "COMMIT_SETTLE_DENIED"
          : !outcome.ok && outcome.reason !== "COMMIT_NOT_REACHED" ? outcome.reason : "COMMIT_DENIED",
        reasonCode: authorised.reasonCode,
        message: authorised.message,
        head: outcome.head,
        failureClass: "policy",
      };
    }
    return outcome;
  }

  /** The commit's parent is the base, its change is exactly the observed one, and nothing is left over. */
  private async verifyCommit(facts: TurnFacts, head: string, first: Observation): Promise<Decision<void>> {
    const worktree = facts.claim.worktree;
    const parent = await git(worktree, ["rev-parse", "--verify", `${head}^1`], { allowFailure: true });
    if (parent.exitCode !== 0 || parent.stdout.trim() !== facts.baseHead) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the commit's parent is not the turn's base", { head });
    }
    const tree = await git(worktree, [...HARDENED, "diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--raw", facts.baseHead, head], { allowFailure: true });
    if (tree.exitCode !== 0) return deny(ReasonCode.PROBE_FAILED, "the commit's change cannot be read", { head });
    const committed = parseRawDiff(tree.stdout);
    const expected = first.entries.map((entry) => `${entry.path}\0${entry.mode ?? "-"}\0${entry.blob ?? "-"}`).sort();
    const actual = committed.map((entry) => `${entry.path}\0${entry.mode ?? "-"}\0${entry.blob ?? "-"}`).sort();
    if (expected.join("\n") !== actual.join("\n")) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the commit differs from the verified change", { head });
    }
    const left = await git(worktree, [...HARDENED, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { allowFailure: true });
    if (left.exitCode !== 0 || left.stdout.length > 0) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the worktree still differs from the commit", { head });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * The worktree after a turn, relative to its base. Git's own control files are compared byte for
   * byte before any git command runs here: a worker that rewrote `.git/config` or a hook could
   * otherwise run code as the daemon through the very commands that inspect its work.
   */
  private async observe(facts: TurnFacts): Promise<Observation> {
    const refused = (reason: string, reasonCode: ReasonCode, message: string): Observation => ({
      problem: { reason, reasonCode, message },
      entries: [],
      diffDigest: null,
      outOfScope: [],
      agentConfiguration: [],
    });
    const worktree = facts.claim.worktree;
    try {
      if (gitControlDigest(facts.gitDirs) !== facts.gitControlDigest) {
        return refused("GIT_CONTROL_CHANGED", ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "git configuration, hooks or HEAD changed during the turn");
      }
      const head = await git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFailure: true });
      const branch = await git(worktree, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true });
      if (head.stdout.trim() !== facts.baseHead || branch.stdout.trim() !== facts.claim.branch) {
        return refused("HEAD_MOVED", ReasonCode.WRITE_EFFECT_FENCE_LOST, "HEAD or the branch moved during the turn");
      }
      const status = await git(worktree, [...HARDENED, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { allowFailure: true });
      if (status.exitCode !== 0) return refused("STATUS_UNREADABLE", ReasonCode.PROBE_FAILED, "the worktree status cannot be read");
      const parsed = parseStatus(status.stdout);
      if (parsed.some((entry) => entry.index !== " " && entry.index !== "?")) {
        return refused("INDEX_CHANGED", ReasonCode.WRITE_EFFECT_FENCE_LOST, "something was staged during the turn");
      }
      const entries: WorkerDiffEntry[] = [];
      const outOfScope = new Set<string>();
      const agentConfiguration = new Set<string>();
      for (const { path } of parsed) {
        if (isAgentConfiguration(path)) agentConfiguration.add(path);
        const entry = diffEntry(worktree, path, facts.objectFormat);
        if (entry === null) {
          outOfScope.add(path);
          continue;
        }
        entries.push(entry);
        if (!insideOwned(path, facts.claim.ownedPaths)) outOfScope.add(path);
      }
      // The turn started with none (`prepareWorktree`), so any listed now is the turn's, ignored or not.
      for (const path of await untrackedAgentConfiguration(worktree)) agentConfiguration.add(path);
      for (const path of agentConfiguration) outOfScope.add(path);
      return {
        problem: null,
        entries,
        diffDigest: entries.length > 0 ? workerDiffDigest(facts.baseHead, entries) : null,
        outOfScope: [...outOfScope].sort(),
        agentConfiguration: [...agentConfiguration].sort(),
      };
    } catch (error) {
      return refused("OBSERVATION_FAILED", ReasonCode.PROBE_FAILED, errorText(error).slice(0, 500));
    }
  }

  private isRunning(executionId: string): boolean {
    return this.ports.tasks.execution(executionId)?.status === "RUNNING";
  }

  private fail(
    facts: TurnFacts,
    executionId: string,
    status: "FAILED" | "TIMEOUT",
    failureClass: FailureClass,
    evidence: Record<string, unknown>,
  ): void {
    const finished = this.ports.tasks.finishExecution(executionId, { status, failureClass, resultDigest: null }, facts.runId);
    if (!finished.allowed) {
      this.refuseLate(facts, executionId, { ...evidence, attemptedStatus: status, finishReasonCode: finished.reasonCode });
      return;
    }
    this.ports.audit.record({
      kind: WorkerTurnEvent.FAILED,
      runId: facts.runId,
      sessionId: facts.worker.sessionId,
      roleKey: facts.worker.roleKey,
      reasonCode: (evidence["reasonCode"] as ReasonCode | undefined) ?? null,
      evidence: { executionId, taskId: facts.taskId, status, failureClass, ...evidence } as Evidence,
    });
  }

  /** A result for an execution that is no longer RUNNING is refused, and recorded with its diagnostics. */
  private refuseLate(facts: TurnFacts, executionId: string, evidence: Record<string, unknown>): void {
    this.ports.audit.record({
      kind: WorkerTurnEvent.LATE_RESULT_REFUSED,
      runId: facts.runId,
      sessionId: facts.worker.sessionId,
      roleKey: facts.worker.roleKey,
      reasonCode: ReasonCode.BINDING_GENERATION_STALE,
      evidence: {
        executionId,
        taskId: facts.taskId,
        status: this.ports.tasks.execution(executionId)?.status ?? null,
        ...evidence,
      } as Evidence,
    });
  }

  private eventsFor(runId: string, executionId: string): Array<{ kind: string; evidence: Evidence }> {
    return this.ports.db
      .all<{ kind: string; evidence_json: string }>(
        `SELECT kind, evidence_json FROM audit_events
          WHERE run_id = ? AND kind IN (?, ?, ?, ?, ?, ?, ?)
            AND json_extract(evidence_json, '$.executionId') = ?
          ORDER BY event_id`,
        [runId, ...Object.values(WorkerTurnEvent), executionId],
      )
      .map((row) => ({ kind: row.kind, evidence: JSON.parse(row.evidence_json) as Evidence }));
  }

  /**
   * An earlier turn of this task whose process a restart could not identify, while that process may
   * still live: its pid was never recorded, or its process group still has a member.
   */
  private blockedOrphan(taskId: string): { executionId: string; pid: number | null } | null {
    const rows = this.ports.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events
        WHERE kind = ? AND json_extract(evidence_json, '$.taskId') = ?
        ORDER BY event_id`,
      [WorkerTurnEvent.ORPHAN_UNIDENTIFIED, taskId],
    );
    for (const row of rows) {
      const evidence = JSON.parse(row.evidence_json) as { executionId?: unknown; pid?: unknown };
      const pid = typeof evidence.pid === "number" ? evidence.pid : null;
      if (pid === null || this.#processes.alive(pid) || this.#processes.groupAlive(pid)) {
        return { executionId: String(evidence.executionId ?? ""), pid };
      }
    }
    return null;
  }

  /** Whether the guard admitted a provider launch for this receipt; a launch with no recorded pid is then unidentifiable. */
  private launchWasAuthorised(executionId: string): boolean {
    return Boolean(this.ports.db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events
        WHERE kind = 'MANAGED_WRITE_GUARD'
          AND json_extract(evidence_json, '$.taskReceiptId') = ?
          AND json_extract(evidence_json, '$.operation') = 'FILE_MUTATION'
          AND json_extract(evidence_json, '$.allowed') = 1
        LIMIT 1`,
      [executionId],
    ));
  }
}

/** `git status --porcelain=v1 -z --no-renames`: `XY path` records, NUL-terminated. */
const parseStatus = (stdout: string): Array<{ index: string; worktree: string; path: string }> =>
  stdout
    .split("\0")
    .filter((record) => record.length >= 4)
    .map((record) => ({ index: record[0]!, worktree: record[1]!, path: record.slice(3) }));

/** `git diff-tree -r -z --raw`: `:oldmode newmode oldsha newsha status` then the path. */
const parseRawDiff = (stdout: string): Array<{ path: string; mode: string | null; blob: string | null }> => {
  const fields = stdout.split("\0").filter((field) => field.length > 0);
  const out: Array<{ path: string; mode: string | null; blob: string | null }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index]!.replace(/^:/, "").split(" ");
    const status = meta[4] ?? "";
    const deleted = status.startsWith("D");
    out.push({ path: fields[index + 1]!, mode: deleted ? null : (meta[1] ?? null), blob: deleted ? null : (meta[3] ?? null) });
  }
  return out;
};

/** One changed path as the filesystem holds it; null for anything git would not commit as a file. */
const diffEntry = (worktree: string, path: string, format: "sha1" | "sha256"): WorkerDiffEntry | null => {
  const full = join(worktree, path);
  let stat: Stats;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { path, mode: null, sha256: null, blob: null };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(readlinkSync(full));
    return { path, mode: "120000", sha256: sha256(target), blob: gitBlobId(format, target) };
  }
  if (stat.isFile()) {
    const bytes = readFileSync(full);
    return { path, mode: (stat.mode & 0o100) !== 0 ? "100755" : "100644", sha256: sha256(bytes), blob: gitBlobId(format, bytes) };
  }
  // A directory (nested repository or submodule) or a special file is never a worker's change to commit.
  return null;
};

/**
 * Bytes of the git files that decide what git *runs* or what HEAD *is*: config, attributes, hooks and
 * HEAD, in the worktree's git dir and its common dir. Read with the filesystem, never with git.
 */
const gitControlDigest = (gitDirs: readonly string[]): string => {
  const parts: Array<{ path: string; bytes: string | null }> = [];
  const read = (path: string): void => {
    try {
      parts.push({ path, bytes: sha256(readFileSync(path)) });
    } catch {
      parts.push({ path, bytes: null });
    }
  };
  for (const dir of gitDirs) {
    for (const file of ["config", "config.worktree", "HEAD", join("info", "attributes")]) read(join(dir, file));
    let hooks: string[] = [];
    try {
      hooks = readdirSync(join(dir, "hooks")).sort();
    } catch {
      hooks = [];
    }
    for (const hook of hooks) read(join(dir, "hooks", hook));
  }
  return digestOf(parts);
};

const workerPrompt = (facts: TurnFacts): string =>
  [
    "You are the implementer for one task of a managed run. Make the change by editing files in this working tree.",
    "",
    `Task: ${facts.taskTitle}`,
    `Specification (JSON): ${JSON.stringify(facts.taskSpec)}`,
    "",
    "Rules:",
    `- Change only files under these repository paths: ${facts.claim.ownedPaths.join(", ")}.`,
    "- Do not run commands, do not commit, and do not touch the .git directory. The control plane verifies your change and commits it.",
    "- When you are done, reply with a short summary of what you changed.",
  ].join("\n");

/** A plain subject from the task's title; the commit carries no provider, model or session metadata. */
const commitMessage = (facts: TurnFacts): string => {
  const subject = facts.taskTitle.replace(/\s+/g, " ").trim().slice(0, 120);
  return subject.length > 0 ? subject : "Apply the worker's change";
};
