import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { allow, deny, isAcpError, type Decision, type Evidence } from "../core/errors.ts";
import { readProcessArgv, readProcessStartToken } from "../core/process-argv.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { fixedRuntimes } from "../domain/fixed-role-runtime.ts";
import { type FailureClass, Role, RunKind, SessionLifecycle, TaskState, roleKeyFor } from "../domain/types.ts";
import { type ManagedWriteGuard, WriteOperation } from "../guard/managed-write-guard.ts";
import { canonical } from "../guard/workspace-probe.ts";
import type { InvocationResult, ProviderAdapter } from "../runtime/provider.ts";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRecord, TaskGraph } from "./task-graph.ts";
import {
  TASK_BRANCH_CREATED,
  TASK_BRANCH_CREATING,
  TASK_BRANCH_CREATION_UNDONE,
  type TaskWriteTarget,
  TaskWriteTargets,
  branchCreationAttempted,
  branchCreations,
  unresolvedCreationAttempt,
  recordedWriteTarget,
  sameWriteTarget,
} from "./task-write-target.ts";
import { ORPHAN_RESOLVED_EVENT, ORPHAN_UNIDENTIFIED_EVENT, unresolvedUnidentifiedOrphans } from "./worker-orphan-release.ts";
import {
  type PinnedRepository,
  type WorkerCommitPort,
  type WorkerDiffEntry,
  committedChanges,
  dotGitFingerprint,
  effectiveConfig,
  gitDirFingerprint,
  headOf,
  ignoredPathState,
  ignoredPathsChanged,
  objectFormatOf,
  parentOf,
  pinRepository,
  plumbingWorkerCommit,
  type GitChildren,
  type GitChildrenClosed,
  type GitRun,
  type GitProcessGroup,
  indexSnapshot,
  runPinnedGit,
  scanAgainst,
  stagedAgainst,
  stagedContent,
} from "./worker-git.ts";

export type { WorkerCommitPort, WorkerDiffEntry } from "./worker-git.ts";

/**
 * #512 — the control plane runs one worker turn for a task the CTO chose.
 *
 * The CTO decides which task runs and when (PRD §8.3, §14.4); the control plane owns the lifecycle,
 * the receipts and the evidence (§8.6, §25.2). So `task_worker_run` hands this runner three names —
 * run, task, claim — and everything else is read from durable facts: the task's live WORKER binding
 * and the session its actor serves now, and the claim's worktree, branch and owned paths.
 *
 * The success order is fixed: the provider edits → its process is confirmed gone → the change is
 * observed twice and must not move between the two → the run's authority is re-checked through the
 * Managed Write Guard → the control plane commits exactly the observed paths → the commit is checked
 * against the observation → only then is the execution finished SUCCEEDED, in the same transaction as
 * the evidence its digest is computed from. Nothing is ever reset or cleaned: a failure leaves every
 * byte where the turn left it. Every git call is pinned and filter-free (`worker-git.ts`).
 *
 * The worker's process is tracked apart from its execution's status (ACP-WORKER-03): a takeover or a
 * cancel ends the execution at once, while the child may still be running. The process stays
 * outstanding until it is confirmed gone; until then no other turn of the task starts, and a restart
 * reconciles it whatever the execution's status says.
 */

/** A worker turn may not be asked to run longer than this (#512). */
export const WORKER_TURN_MAX_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * The Claude pair this path used to launch for every worker. A turn now runs on the bound
 * session's own fixed pair (`fixedRuntimes(Role.WORKER)`). These stay exported for callers that
 * name the Claude pair; they are not the only runtime.
 */
export const WORKER_TURN_PROVIDER = "claude";
export const WORKER_TURN_MODEL = "opus";

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_PROCESS_SETTLE_MS = 2_000;
const DEFAULT_SHUTDOWN_BUDGET_MS = 15_000;
/** How long a stopping daemon waits, after SIGKILL, to see each worker git child's exit (ACP-WORKER-03). */
const GIT_REAP_BOUND_MS = 5_000;
/** The bounded second attempt for a group the first one could not confirm empty. */
const GIT_REAP_RETRY_MS = 10_000;

/** Audit kinds this runner writes; `describe` reads them back. */
export const WorkerTurnEvent = {
  STARTED: "TASK_WORKER_TURN_STARTED",
  SUCCEEDED: "TASK_WORKER_TURN_SUCCEEDED",
  FAILED: "TASK_WORKER_TURN_FAILED",
  LATE_RESULT_REFUSED: "TASK_WORKER_TURN_LATE_RESULT_REFUSED",
  ORPHAN_KILLED: "TASK_WORKER_ORPHAN_KILLED",
  ORPHAN_GONE: "TASK_WORKER_ORPHAN_GONE",
  ORPHAN_UNIDENTIFIED: ORPHAN_UNIDENTIFIED_EVENT,
  /**
   * #1096 — an operator's repair (`release_unidentified_worker_orphan`) recorded an unidentified orphan
   * with no recorded pid as resolved, after confirming nothing of it runs. The orphan row stays, and the
   * row counts only as `orphanResolutionVerified` verifies it as that repair's own release record.
   */
  ORPHAN_RESOLVED: ORPHAN_RESOLVED_EVENT,
  SHUTDOWN_DRAINED: "TASK_WORKER_TURNS_DRAINED",
  /** A stopping daemon stopped a turn's git and recorded what the repository shows (ACP-WORKER-03). */
  GIT_STOPPED: "TASK_WORKER_TURN_GIT_STOPPED",
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
  /** The command line of a live pid as the OS reports it; null when it cannot be read. */
  argv(pid: number): readonly string[] | null;
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
  argv: (pid) => readProcessArgv(pid),
  killGroup: (pid) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
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
  /** Allocates a turn's private git scratch. Defaults to the control plane's own scratch root. */
  scratchDir?: (prefix: string) => string;
  /** How long a finished turn waits for its process group to go before killing it, and again after. */
  processSettleMs?: number;
}

/** Ports the runner needs; the composition root supplies them, none is a service it could misuse. */
export interface WorkerTurnPorts {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  tasks: TaskGraph;
  guard: ManagedWriteGuard;
  /** The adapter that serves the WORKER role for the bound session's provider. */
  workerAdapter: (provider: string) => ProviderAdapter;
}

interface WorkerIdentity {
  roleKey: string;
  sessionId: string;
  incarnation: string;
  generation: number;
  externalSessionId: string;
  provider: string;
  model: string;
}

interface ClaimFacts {
  claimId: string;
  repositoryId: string;
  repositoryIdentity: string;
  worktree: string;
  branch: string;
  ownedPaths: string[];
  /** The run's base branch for the claim's repository (`run_repositories.base_branch`). */
  baseBranch: string;
}

interface DurableFacts {
  runId: string;
  taskId: string;
  taskTitle: string;
  taskSpec: unknown;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  /** The run owner's pinned incarnation, named in the guard request for the task's branch. */
  ownerSessionIncarnation: string | null;
  worker: WorkerIdentity;
  claim: ClaimFacts;
  /**
   * #512 S-TB — the write target the control plane recorded for the task (`task-write-target.ts`),
   * which the claim matched; null for a task with no record, which runs exactly as before.
   */
  writeTarget: TaskWriteTarget | null;
}

interface TurnFacts extends DurableFacts {
  repo: PinnedRepository;
  baseHead: string;
  objectFormat: "sha1" | "sha256";
  /** `git config --list --show-origin` before the turn. */
  config: string;
  /** Every git-dir file before the turn (bar the index). */
  gitDirFingerprint: string;
  /** What the real index staged before the turn (`stagedContent`): its entries, never its stat cache. */
  stagedBaseline: string;
  /** #1097 — every ignored path's state before the turn (`ignoredPathState`), or why it could not be read. */
  ignoredBaseline: IgnoredReading;
}

/** #1097 — a reading of the worktree's ignored paths; a failed one is kept as its error, never as empty. */
type IgnoredReading = { state: ReadonlyMap<string, string>; error: null } | { state: null; error: string };

/** How many changed ignored paths a receipt names; the total is always given. */
const IGNORED_CHANGES_NAMED = 200;

interface InFlightTurn {
  promise: Promise<void>;
  controller: AbortController;
  /** Set by `shutdown`: the turn ends ABANDONED with the daemon, not FAILED. */
  stopping: boolean;
  executionId: string;
  facts: TurnFacts;
  /** Whether `promise` has settled; a drain that times out fences the turns still running. */
  settled: boolean;
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
    workerProcessReleasedAt: string | null;
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

export type ReconcileOutcome = "KILLED" | "KILL_UNCONFIRMED" | "GONE" | "NEVER_LAUNCHED" | "UNIDENTIFIED";

/** Whether a live pid was confirmed, immediately before a kill, as the process an execution launched. */
type ProcessOwnership = "OWNED" | "START_TIME_NOT_CONFIRMED" | "COMMAND_LINE_NOT_CONFIRMED";

const insideOwned = (path: string, owned: readonly string[]): boolean =>
  owned.some((root) => root === "." || path === root || path.startsWith(`${root}/`));

const errorText = (error: unknown): string =>
  isAcpError(error) ? `${error.reasonCode}: ${error.message}` : error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One worker process as an execution records it: the execution, the pid and its OS start time. */
export interface WorkerProcessIdentity {
  executionId: string;
  pid: number;
  startedAt: string | null;
}

/**
 * #1070 ACP-WORKER-03 — the authority to record a worker process, or to record it released.
 *
 * Minted only in this module, by the runner: a record authority in the spawn report of its own
 * invocation, for the pid and start time the provider reported; a release authority at the moment it
 * has confirmed that exact process gone. Each is scoped to its one process — the database's triggers
 * accept the write only for the execution, pid and start time the token names — and a record token
 * never releases nor a release token records. Callers never construct one, and a raw statement never
 * holds one.
 */
class WorkerProcessAuthorityToken {
  readonly #minted = true;
  readonly #db: Db;
  readonly #kind: "record" | "release";
  readonly #process: WorkerProcessIdentity;

  constructor(db: Db, kind: "record" | "release", process: WorkerProcessIdentity) {
    this.#db = db;
    this.#kind = kind;
    this.#process = Object.freeze({ ...process });
  }

  static processOf(value: unknown, db: Db, kind: "record" | "release"): WorkerProcessIdentity | null {
    if (typeof value !== "object" || value === null || !(#minted in value)) return null;
    const token = value as WorkerProcessAuthorityToken;
    return token.#db === db && token.#kind === kind ? token.#process : null;
  }
}

export type WorkerProcessAuthority = WorkerProcessAuthorityToken;
export const workerProcessRecordOf = (value: unknown, db: Db): WorkerProcessIdentity | null =>
  WorkerProcessAuthorityToken.processOf(value, db, "record");
export const workerProcessReleaseOf = (value: unknown, db: Db): WorkerProcessIdentity | null =>
  WorkerProcessAuthorityToken.processOf(value, db, "release");

export class WorkerTurnRunner {
  readonly #turns = new Map<string, InFlightTurn>();
  /** Starts still being admitted: preparing, or opening their execution, and not yet a turn. */
  readonly #admissions = new Set<Promise<void>>();
  /**
   * Every git registry this runner opened — for running turns, settled ones and admissions alike —
   * until its owner retired it and it has no group left (ACP-WORKER-03). A settled turn's git child
   * can leave a descendant in its group; shutdown stops that too before the daemon lets go.
   */
  readonly #gitRegistries = new Set<GitChildren>();
  readonly #busyWorktrees = new Set<string>();
  readonly #pollMs: number;
  readonly #processes: WorkerProcessPort;
  readonly #commit: WorkerCommitPort;
  readonly #beforeCommit: (() => void | Promise<void>) | undefined;
  readonly #scratchDir: (prefix: string) => string;
  readonly #processSettleMs: number;
  #stopping = false;

  constructor(private readonly ports: WorkerTurnPorts, options: WorkerTurnOptions = {}) {
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#processes = options.processes ?? osWorkerProcesses;
    this.#commit = options.commit ?? plumbingWorkerCommit;
    this.#beforeCommit = options.beforeCommit;
    this.#scratchDir = options.scratchDir ?? acpScratchDir;
    this.#processSettleMs = options.processSettleMs ?? DEFAULT_PROCESS_SETTLE_MS;
  }

  /**
   * Starts one worker turn and returns its execution id at once; the turn runs on.
   *
   * Refused before anything is recorded when a durable fact does not hold — and refused, not
   * repaired, when the claimed worktree is not clean: a previous attempt's preserved bytes or
   * another writer's are never reset, cleaned or folded into this turn (#512).
   */
  async start(request: WorkerTurnRequest): Promise<Decision<{ executionId: string }>> {
    if (this.#stopping) return this.stoppingRefusal(request.taskId);
    // ACP-WORKER-03: an admission is tracked from its first step, not from its launch. A shutdown that
    // begins while it is still preparing waits for it, and it launches nothing once shutdown has begun.
    let settle!: () => void;
    const admission = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#admissions.add(admission);
    try {
      return await this.admit(request);
    } finally {
      this.#admissions.delete(admission);
      settle();
    }
  }

  private stoppingRefusal(taskId: string): Decision<never> {
    return deny(ReasonCode.CONFLICT, "the daemon is stopping; no worker turn starts", { taskId });
  }

  private async admit(request: WorkerTurnRequest): Promise<Decision<{ executionId: string }>> {
    const timeoutMs = Math.min(request.timeoutMs ?? WORKER_TURN_MAX_TIMEOUT_MS, WORKER_TURN_MAX_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a worker turn timeout must be a positive number of milliseconds", {
        timeoutMs: request.timeoutMs ?? null,
      });
    }
    // #512 S-TB (c98ea8a3) — a STANDARD_WORK task with no recorded target gets one here, through the
    // same official derivation provisioning uses, or is refused: it never runs on a target it has not.
    const recorded = await this.ensureWriteTarget(request);
    if (!recorded.allowed) return recorded as Decision<{ executionId: string }>;
    const durable = this.readFacts(request);
    if (!durable.allowed) return durable as Decision<{ executionId: string }>;
    const facts = durable.value;
    let adapter: ProviderAdapter;
    try {
      adapter = this.ports.workerAdapter(facts.worker.provider);
    } catch (error) {
      return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "no worker runtime is registered for this deployment", {
        provider: facts.worker.provider,
        error: errorText(error).slice(0, 300),
      });
    }
    const worktree = facts.claim.worktree;
    if (this.#busyWorktrees.has(worktree)) {
      return deny(ReasonCode.CONFLICT, "the claimed worktree already has a worker turn in flight", { worktreeId: worktree });
    }
    this.#busyWorktrees.add(worktree);
    let scratch: string | null = null;
    let launched = false;
    let preparedRepo: PinnedRepository | null = null;
    try {
      scratch = this.#scratchDir("acp-worker-git-");
      // #512 S-TB — a task with a recorded write target gets its branch made, or re-entered, here,
      // before the worktree it starts from is read; a task without one runs exactly as before.
      if (facts.writeTarget) {
        const branched = await this.prepareTaskBranch(facts, facts.writeTarget, scratch);
        if (this.#stopping) return this.stoppingRefusal(request.taskId);
        if (!branched.allowed) return branched as Decision<{ executionId: string }>;
      }
      const prepared = await this.prepareWorktree(facts, scratch);
      if (this.#stopping) return this.stoppingRefusal(request.taskId);
      if (!prepared.allowed) return prepared as Decision<{ executionId: string }>;
      const turn = prepared.value;
      preparedRepo = turn.repo;
      const started = await this.ports.tasks.startWorkerExecution({
        runId: turn.runId,
        taskId: turn.taskId,
        ownerBindingGeneration: turn.ownerBindingGeneration,
        workerSessionId: turn.worker.sessionId,
        provider: facts.worker.provider,
        model: facts.worker.model,
        repositoryId: turn.claim.repositoryId,
        worktreeId: worktree,
        concurrencyWidth: this.ports.tasks.runningWidth(turn.runId) + 1,
        runtimeManaged: true,
      }, () => !this.#stopping);
      if (!started.allowed) return this.#stopping ? this.stoppingRefusal(request.taskId) : started as Decision<{ executionId: string }>;
      const executionId = started.value.executionId;
      if (this.#stopping) {
        // Opened in the instant before shutdown began; it is closed, never launched.
        this.ports.tasks.finishExecution(executionId, { status: "ABANDONED", failureClass: "infrastructure" }, turn.runId);
        return this.stoppingRefusal(request.taskId);
      }
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
      const turnScratch = scratch;
      const inFlight: InFlightTurn = {
        promise: Promise.resolve(),
        controller: new AbortController(),
        stopping: false,
        executionId,
        facts: turn,
        settled: false,
      };
      inFlight.promise = this.execute(adapter, turn, executionId, timeoutMs, inFlight).finally(() => {
        inFlight.settled = true;
        turn.repo.children.retire();
        this.pruneGitRegistries();
        this.#busyWorktrees.delete(worktree);
        this.#turns.delete(executionId);
        rmSync(turnScratch, { recursive: true, force: true });
      });
      this.#turns.set(executionId, inFlight);
      return allow(ReasonCode.OK, { executionId });
    } finally {
      if (!launched) {
        this.#busyWorktrees.delete(worktree);
        if (scratch) rmSync(scratch, { recursive: true, force: true });
        (preparedRepo as PinnedRepository | null)?.children.retire();
      }
    }
  }

  /** Resolves when the turn for `executionId` has finished, however it finished. Test and stop seam. */
  async settled(executionId: string): Promise<void> {
    await this.#turns.get(executionId)?.promise;
  }

  /**
   * Stops every owned turn before the daemon gives up its authority (ACP-WORKER-03). No new turn
   * starts; each in-flight turn is aborted (its child's process group is killed) and drained within
   * the budget, and ends ABANDONED. A process that could not be confirmed gone stays recorded as
   * outstanding — durably, so the next start reconciles it and no retry of its task runs before.
   */
  async shutdown(
    budgetMs = DEFAULT_SHUTDOWN_BUDGET_MS,
  ): Promise<{ drained: boolean; outstanding: string[]; gitStopped: boolean; unconfirmedGroups: GitProcessGroup[] }> {
    this.#stopping = true;
    // An admission that sees `#stopping` refuses before it opens an execution or registers a turn, so
    // every turn that will ever exist is already in `#turns`; the admissions are waited for too.
    const admissions = [...this.#admissions];
    const turns = [...this.#turns.values()];
    for (const turn of turns) {
      turn.stopping = true;
      turn.controller.abort();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      Promise.allSettled([...turns.map((turn) => turn.promise), ...admissions]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // ACP-WORKER-03: a turn the drain did not finish is stopped here, before the daemon gives up its
    // authority. First its git: every git child still running against its repository — an update-ref,
    // the index update after it, an object write — is killed with its process group and its exit
    // observed, and the repository is closed, so no git command starts and no index is published for
    // that turn again. Then what the repository shows is recorded: whether the branch moved. Then the
    // execution is ended ABANDONED in the database, so a late resume finds nothing RUNNING to commit for
    // or succeed, in this process or in any successor. `#stopping` is never cleared.
    const fenced: string[] = [];
    for (const turn of turns) {
      if (turn.settled) continue;
      if (this.isRunning(turn.executionId)) {
        this.fail(turn.facts, turn.executionId, "ABANDONED", "infrastructure", {
          reason: "DAEMON_STOPPED_UNDRAINED",
          reasonCode: ReasonCode.INTERNAL_ERROR,
          detail: "the daemon's drain timed out on this turn; it was ended, and its git stopped, before the daemon released its authority",
        });
        fenced.push(turn.executionId);
      }
      const closed = await turn.facts.repo.children.close(GIT_REAP_BOUND_MS);
      this.ports.audit.record({
        kind: WorkerTurnEvent.GIT_STOPPED,
        runId: turn.facts.runId,
        sessionId: turn.facts.worker.sessionId,
        roleKey: turn.facts.worker.roleKey,
        reasonCode: closed.reaped ? ReasonCode.OK : ReasonCode.INTERNAL_ERROR,
        evidence: {
          executionId: turn.executionId,
          taskId: turn.facts.taskId,
          reason: closed.reaped ? "GIT_STOPPED_AT_SHUTDOWN" : "GIT_NOT_CONFIRMED_STOPPED",
          ...(await this.repositoryAtStop(turn.facts, closed)),
        } as Evidence,
      });
    }
    // Then every other registry this runner opened: a settled turn's, a refused admission's. A git child
    // that exited can have left a descendant in its group, and that group is still this daemon's to stop.
    let lingeringGroupsKilled = 0;
    for (const registry of this.#gitRegistries) {
      if (registry.closed) continue;
      lingeringGroupsKilled += (await registry.close(GIT_REAP_BOUND_MS)).killed.length;
    }
    // A bounded second attempt for any group that is not yet confirmed empty, then the verdict.
    for (const registry of this.#gitRegistries) {
      if (registry.liveGroups().length > 0) await registry.close(GIT_REAP_RETRY_MS);
    }
    const unconfirmedGroups = [...this.#gitRegistries].flatMap((registry) => registry.liveGroups());
    const gitStopped = unconfirmedGroups.length === 0;
    this.pruneGitRegistries();
    const outstanding = this.ports.db
      .all<{ execution_id: string }>(
        `SELECT execution_id FROM task_executions
          WHERE runtime_managed = 1 AND worker_process_id IS NOT NULL AND worker_process_released_at IS NULL
          ORDER BY execution_id`,
      )
      .map((row) => row.execution_id);
    const pendingStarts = this.#admissions.size;
    const drained = finished && pendingStarts === 0 && this.#turns.size === 0;
    this.ports.audit.record({
      kind: WorkerTurnEvent.SHUTDOWN_DRAINED,
      evidence: {
        drained, turns: turns.length, admissions: admissions.length, pendingStarts, fenced, gitStopped,
        lingeringGroupsKilled, unconfirmedGroups: unconfirmedGroups.map((group) => group.pgid), executions: outstanding,
      },
    });
    return { drained: drained && outstanding.length === 0 && gitStopped, outstanding, gitStopped, unconfirmedGroups };
  }

  /** Drops every registry whose owner retired it and whose groups are all confirmed empty. */
  private pruneGitRegistries(): void {
    for (const registry of this.#gitRegistries) if (registry.finished) this.#gitRegistries.delete(registry);
  }

  /**
   * What a turn's repository shows once its git children are stopped: whether the branch moved off the
   * turn's base, and whether a ref or index lock was left behind. Read by the stopping daemon itself;
   * the worktree's bytes are not touched.
   */
  private async repositoryAtStop(facts: TurnFacts, closed: GitChildrenClosed): Promise<Record<string, unknown>> {
    const branch = await runPinnedGit(facts.repo, ["rev-parse", "--verify", "-q", `refs/heads/${facts.claim.branch}`], {
      afterClose: true,
    });
    const head = branch.exitCode === 0 ? branch.stdout.trim() : null;
    return {
      refMoved: head === null ? null : head !== facts.baseHead,
      headAtStop: head,
      baseHead: facts.baseHead,
      branchLockLeft: existsSync(join(facts.repo.commonDir, "refs", "heads", `${facts.claim.branch}.lock`)),
      indexLockLeft: existsSync(join(facts.repo.gitDir, "index.lock")),
      indexLockReleasedByStop: closed.indexLockReleased,
      gitChildrenKilled: closed.killed.length,
      gitChildrenReaped: closed.reaped,
      gitChildrenUnreaped: closed.unreaped,
    };
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
        workerProcessReleasedAt: execution.workerProcessReleasedAt,
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
   * Startup reconciliation (#512, ACP-WORKER-03/04). Nothing is ever re-invoked. Every runtime-managed
   * execution still RUNNING, and every recorded worker process not yet confirmed gone — whatever its
   * execution's status — is reconciled.
   *
   * Ownership is decided from one snapshot of the outstanding process claims taken before any state
   * changes, so ending one claimant can never make another look unique. A recorded worker is killed
   * only when its pid, the OS start time read from that pid now, and a single claim on that pid all
   * match; anything less kills nothing and leaves the process outstanding, which keeps its task from
   * another turn until the process is confirmed gone.
   */
  async reconcileAfterRestart(): Promise<Array<{ executionId: string; outcome: ReconcileOutcome }>> {
    const rows = this.ports.db.all<{
      execution_id: string;
      run_id: string;
      task_id: string;
      worker_session_id: string;
      status: string;
      worker_process_id: number | null;
      worker_process_started_at: string | null;
    }>(
      `SELECT execution_id, run_id, task_id, worker_session_id, status, worker_process_id, worker_process_started_at
         FROM task_executions
        WHERE runtime_managed = 1
          AND (status = 'RUNNING' OR (worker_process_id IS NOT NULL AND worker_process_released_at IS NULL))
        ORDER BY execution_id`,
    );
    const claimsOnPid = new Map<number, number>();
    for (const row of rows) {
      if (row.worker_process_id !== null) {
        claimsOnPid.set(row.worker_process_id, (claimsOnPid.get(row.worker_process_id) ?? 0) + 1);
      }
    }
    const outcomes: Array<{ executionId: string; outcome: ReconcileOutcome }> = [];
    for (const row of rows) {
      const pid = row.worker_process_id;
      const recorded = row.worker_process_started_at;
      let outcome: ReconcileOutcome;
      let observed: string | null = null;
      let ownership: ProcessOwnership | null = null;
      if (pid === null) {
        outcome = this.launchWasAuthorised(row.execution_id) ? "UNIDENTIFIED" : "NEVER_LAUNCHED";
      } else if (this.releaseIfGone(row.execution_id, pid, recorded)) {
        outcome = "GONE";
      } else {
        observed = this.#processes.alive(pid) ? this.#processes.startToken(pid) : null;
        const owned = recorded !== null && observed !== null && observed === recorded && claimsOnPid.get(pid) === 1;
        ownership = owned ? this.ownershipOf(row.execution_id, pid, recorded) : null;
        if (owned && ownership === "OWNED") {
          this.#processes.killGroup(pid);
          if (await this.waitGone(pid, recorded, this.#processSettleMs)) {
            this.releaseIfGone(row.execution_id, pid, recorded);
            outcome = "KILLED";
          } else {
            outcome = "KILL_UNCONFIRMED";
          }
        } else {
          outcome = "UNIDENTIFIED";
        }
      }
      const finished = row.status === "RUNNING"
        ? this.ports.tasks.finishExecution(row.execution_id, { status: "ABANDONED", failureClass: "infrastructure" }, row.run_id)
        : null;
      this.ports.audit.record({
        kind: outcome === "KILLED"
          ? WorkerTurnEvent.ORPHAN_KILLED
          : outcome === "UNIDENTIFIED" || outcome === "KILL_UNCONFIRMED"
            ? WorkerTurnEvent.ORPHAN_UNIDENTIFIED
            : WorkerTurnEvent.ORPHAN_GONE,
        runId: row.run_id,
        sessionId: row.worker_session_id,
        reasonCode: finished === null || finished.allowed ? ReasonCode.OK : finished.reasonCode,
        evidence: {
          executionId: row.execution_id,
          taskId: row.task_id,
          status: row.status === "RUNNING" ? "ABANDONED" : row.status,
          reason: `restart reconciled the runtime-managed execution (${row.status}): ${outcome}`,
          pid,
          recordedStartedAt: recorded,
          observedStartedAt: observed,
          claimsOnPid: pid === null ? 0 : (claimsOnPid.get(pid) ?? 0),
          ownership,
          killed: outcome === "KILLED",
          reexecutionBlocked: outcome === "UNIDENTIFIED" || outcome === "KILL_UNCONFIRMED",
        },
      });
      outcomes.push({ executionId: row.execution_id, outcome });
    }
    return outcomes;
  }

  // -------------------------------------------------------------------------

  /**
   * #512 S-TB (c98ea8a3) — the official backfill before a first execution: a STANDARD_WORK task of a
   * run the caller owns, with no recorded write target, gets one derived and recorded exactly as
   * provisioning records one (an already-staffed legacy task included), or this turn is refused with
   * the derivation's own reason. Every other run, caller and recorded task passes untouched.
   */
  private async ensureWriteTarget(request: WorkerTurnRequest): Promise<Decision<void>> {
    const { db } = this.ports;
    const owned = (): Decision<void> => {
      const run = db.get<{ kind: string; owner_session_id: string | null; owner_binding_generation: number | null }>(
        `SELECT kind, owner_session_id, owner_binding_generation FROM runs WHERE run_id = ?`,
        [request.runId],
      );
      return run && run.owner_session_id === request.ownerSessionId && run.owner_binding_generation === request.ownerBindingGeneration
        ? allow(ReasonCode.OK, undefined)
        : deny(ReasonCode.BINDING_GENERATION_STALE, "the run's owner is no longer the caller", { runId: request.runId });
    };
    const run = db.get<{ kind: string }>(`SELECT kind FROM runs WHERE run_id = ?`, [request.runId]);
    const task = db.get<{ run_id: string }>(`SELECT run_id FROM tasks WHERE task_id = ?`, [request.taskId]);
    // Anything else is the durable facts' to refuse, in their own words.
    if (run?.kind !== RunKind.STANDARD_WORK || task?.run_id !== request.runId || !owned().allowed) return allow(ReasonCode.OK, undefined);
    if (recordedWriteTarget(db, request.runId, request.taskId)) return allow(ReasonCode.OK, undefined);
    const targets = new TaskWriteTargets({ db, clock: this.ports.clock, audit: this.ports.audit, scratchDir: this.#scratchDir });
    let ensured: Decision<TaskWriteTarget | null>;
    try {
      ensured = await targets.ensure(request.runId, request.taskId, owned);
    } catch (error) {
      ensured = deny(ReasonCode.INTERNAL_ERROR, "the task's write target could not be recorded", { error: errorText(error).slice(0, 300) });
    }
    if (ensured.allowed) return allow(ReasonCode.OK, undefined);
    return deny(ensured.reasonCode, `the task has no recorded write target and none could be recorded: ${ensured.message}`, {
      ...ensured.evidence,
      taskId: request.taskId,
    });
  }

  /** The durable facts of a turn: run, task, live WORKER identity and the claim. No caller value is trusted. */
  private readFacts(request: WorkerTurnRequest): Decision<DurableFacts> {
    const { db } = this.ports;
    const run = db.get<{
      kind: string;
      state: string;
      owner_session_id: string | null;
      owner_binding_generation: number | null;
      owner_session_incarnation: string | null;
    }>(
      `SELECT kind, state, owner_session_id, owner_binding_generation, owner_session_incarnation FROM runs WHERE run_id = ?`,
      [request.runId],
    );
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
    const outstanding = this.outstandingProcess(request.taskId);
    if (outstanding) {
      return deny(ReasonCode.CONFLICT, "an earlier turn of this task left a worker process that is not confirmed gone; the task is not executed again before it is", {
        taskId: request.taskId,
        executionId: outstanding.executionId,
        pid: outstanding.pid,
      });
    }
    const blocked = this.blockedOrphan(request.taskId);
    if (blocked) {
      return deny(ReasonCode.CONFLICT, "an earlier turn of this task may have launched a process that was never recorded; it is not executed again", {
        taskId: request.taskId,
        executionId: blocked.executionId,
        // #1096 — the record the operator's release names (`release_unidentified_worker_orphan`).
        orphanEventId: blocked.eventId,
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
    const writeTarget = recordedWriteTarget(db, request.runId, request.taskId);
    // c98ea8a3 (S-TB-01) — whether or not a record exists decides nothing on its own: a STANDARD_WORK
    // task with none is refused, whatever its claim names.
    if (!writeTarget && run.kind === RunKind.STANDARD_WORK) {
      return deny(
        ReasonCode.CONFLICT,
        "a STANDARD_WORK task runs only on the write target the control plane recorded for it, and this task has none",
        { runId: request.runId, taskId: request.taskId },
      );
    }
    if (writeTarget) {
      const matched = this.matchesWriteTarget(request, spec, claim.value, writeTarget);
      if (!matched.allowed) return matched as Decision<never>;
    }
    return allow(ReasonCode.OK, {
      runId: request.runId,
      taskId: request.taskId,
      taskTitle: task.title,
      taskSpec: spec,
      ownerSessionId: request.ownerSessionId,
      ownerBindingGeneration: request.ownerBindingGeneration,
      ownerSessionIncarnation: run.owner_session_incarnation,
      worker: worker.value,
      claim: claim.value,
      writeTarget,
    });
  }

  /**
   * #512 S-TB — the claim a turn runs under names exactly the task's recorded write target: its
   * repository, its branch and its paths, no more and no fewer; and the task's spec still names that
   * record, so what the CTO read, what it claimed and what is verified here are one value.
   */
  private matchesWriteTarget(
    request: WorkerTurnRequest,
    spec: unknown,
    claim: ClaimFacts,
    target: TaskWriteTarget,
  ): Decision<void> {
    const named = typeof spec === "object" && spec !== null ? (spec as Record<string, unknown>)["writeTarget"] : undefined;
    if (!sameWriteTarget(named, target)) {
      return deny(ReasonCode.CONFLICT, "the task's spec no longer names the write target the control plane recorded for it", {
        taskId: request.taskId,
      });
    }
    const paths = [...new Set(target.paths)].sort();
    if (
      claim.repositoryIdentity !== target.repositoryIdentity ||
      claim.branch !== target.branch ||
      claim.ownedPaths.length !== paths.length ||
      claim.ownedPaths.some((path, index) => path !== paths[index])
    ) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the claim does not name the task's recorded write target", {
        taskId: request.taskId,
        claimId: request.claimId,
        claimed: { repositoryIdentity: claim.repositoryIdentity, branch: claim.branch, paths: claim.ownedPaths },
        recorded: { repositoryIdentity: target.repositoryIdentity, branch: target.branch, paths },
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** The ACTIVE `WORKER:<taskId>` binding of this run and the READY fixed-runtime session its actor serves now. */
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
    const provider = row.provider ?? "";
    const fixed = fixedRuntimes(Role.WORKER).find((runtime) => runtime.provider === provider);
    if (!fixed || row.model !== fixed.model) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a worker turn runs on the session's fixed provider and model", {
        taskId,
        provider: row.provider,
        model: row.model,
        ...(fixed ? { required: fixed.model } : {}),
      });
    }
    return allow(ReasonCode.OK, {
      roleKey: row.role_key,
      sessionId: row.current_session_id,
      incarnation: row.current_session_incarnation,
      generation: row.binding_generation,
      externalSessionId: row.current_session_incarnation.split("#", 1)[0] ?? row.current_session_id,
      provider: fixed.provider,
      model: fixed.model,
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
    const repository = db.get<{ repository_id: string; checkout_path: string; base_branch: string }>(
      `SELECT r.repository_id, r.checkout_path, rr.base_branch
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
      baseBranch: repository.base_branch,
    });
  }

  /**
   * The worktree a turn may start from: the registered checkout's git dir pinned, on the claim's
   * branch, its index staging nothing, and every byte equal to HEAD's tree — computed here, with no
   * git command that could apply a filter. Anything else is refused, never reset: on a retry this is
   * what verifies that the previous attempt's preserved state is safe to build on. The configuration
   * and the git dir are recorded last, as the baseline the turn is held to.
   */
  private async prepareWorktree(facts: DurableFacts, scratch: string): Promise<Decision<TurnFacts>> {
    let opened: GitChildren | null = null;
    const prepared = await this.prepareWorktreeOnce(facts, scratch, (children) => {
      opened = children;
    });
    // A preparation that refuses starts no more git against the repository it pinned.
    if (!prepared.allowed) (opened as GitChildren | null)?.retire();
    return prepared;
  }

  private async prepareWorktreeOnce(
    facts: DurableFacts,
    scratch: string,
    onOpened: (children: GitChildren) => void,
  ): Promise<Decision<TurnFacts>> {
    const worktree = facts.claim.worktree;
    try {
      const pinned = pinRepository(worktree, scratch);
      if (pinned.allowed) {
        this.#gitRegistries.add(pinned.value.children);
        onOpened(pinned.value.children);
      }
      if (!pinned.allowed) return pinned as Decision<never>;
      const repo = pinned.value;
      const objectFormat = await objectFormatOf(repo);
      const { head, branch } = await headOf(repo);
      if (!head) return deny(ReasonCode.PROBE_FAILED, "the claimed worktree has no HEAD commit", { worktreeId: worktree });
      if (branch !== facts.claim.branch) {
        return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the claimed worktree is not on the claimed branch", {
          worktreeId: worktree,
          branch: facts.claim.branch,
          observed: branch,
        });
      }
      // ACP-WORKER-06: one snapshot of the index answers both questions — is anything staged, and what
      // is the baseline the turn is held to — so nothing staged between two reads becomes the baseline.
      // Staging after the snapshot differs from the baseline, which observation and the commit refuse.
      const snapshot = indexSnapshot(repo, "prepare");
      const staged = await stagedAgainst(repo, head, snapshot);
      const scan = await scanAgainst(repo, head, objectFormat, "prepare");
      // ACP-WORKER-05: a checked-out submodule keeps its state in another repository, which this
      // runner never runs git inside, so it cannot verify one is clean or that a turn left it alone.
      if (scan.populatedGitlinks.length > 0) {
        return deny(
          ReasonCode.CONFLICT,
          "the claimed worktree has a checked-out or replaced submodule; a worker turn cannot verify one, so it does not start",
          { worktreeId: worktree, paths: scan.populatedGitlinks.slice(0, 50) },
        );
      }
      const dirty = [...staged, ...scan.entries.map((entry) => entry.path), ...scan.unsafe];
      if (dirty.length > 0) {
        return deny(
          ReasonCode.CONFLICT,
          "the claimed worktree holds uncommitted changes; a worker turn starts only from a clean tree, and the control plane never resets or cleans one",
          { worktreeId: worktree, paths: [...new Set(dirty)].slice(0, 50) },
        );
      }
      // Git's ignore rules hide `.claude/settings.local.json` from a status. Left by an earlier turn, it
      // would be loaded by this one's CLI (the `local` setting source), so a turn starts only when the
      // root's agent configuration is all tracked — never cleaned away here.
      if (scan.untrackedAgentConfiguration.length > 0) {
        return deny(
          ReasonCode.CONFLICT,
          "the claimed worktree holds agent configuration git does not track; a worker turn would load it, and the control plane never removes it",
          { worktreeId: worktree, paths: scan.untrackedAgentConfiguration.slice(0, 50) },
        );
      }
      const config = await effectiveConfig(repo);
      const stagedBaseline = await stagedContent(repo, snapshot);
      const ignoredBaseline = await readIgnored(repo, head, "prepare");
      return allow(ReasonCode.OK, {
        ...facts,
        repo,
        baseHead: head,
        objectFormat,
        config,
        stagedBaseline,
        ignoredBaseline,
        gitDirFingerprint: gitDirFingerprint(repo),
      });
    } catch (error) {
      return deny(ReasonCode.PROBE_FAILED, "the claimed worktree could not be inspected", {
        worktreeId: worktree,
        error: errorText(error).slice(0, 500),
      });
    }
  }

  /**
   * #512 S-TB (CEO 0a16329c) — before a task's first execution, the control plane makes the task's
   * work branch, or re-enters it, so the turn starts on the recorded target and nowhere else:
   *
   * - The registered checkout already on the task's branch is a re-entry, taken as it is.
   * - On the run's base branch, and clean, the task's branch is created at the run's pinned base
   *   commit (create-only: a ref that exists is never overwritten) and checked out, as one GIT_BRANCH
   *   write the Managed Write Guard approves for the run's owner and the claim it holds. The base
   *   branch's ref is never written, whatever it names now.
   * - A branch of that name that exists is used only when it descends from the pinned base and every
   *   commit past it is one this task's turns made; anything else is refused and left as it is.
   * - A checkout with changes is refused and its changes are left where they are; a checkout on any
   *   other branch is refused and not moved. Nothing is reset, cleaned, pushed or forced.
   *
   * The checkout is moved with plumbing (`update-ref`, `read-tree -m -u`, `symbolic-ref`) under the
   * hardened pinned git: no hook runs, and a repository that configures a filter driver is refused
   * rather than have one run to move its files.
   */
  private async prepareTaskBranch(facts: DurableFacts, target: TaskWriteTarget, scratch: string): Promise<Decision<void>> {
    let opened: GitChildren | null = null;
    try {
      const pinned = pinRepository(facts.claim.worktree, scratch);
      if (!pinned.allowed) return pinned as Decision<never>;
      opened = pinned.value.children;
      this.#gitRegistries.add(opened);
      return await this.prepareTaskBranchOn(pinned.value, facts, target);
    } catch (error) {
      return deny(ReasonCode.PROBE_FAILED, "the claimed worktree could not be prepared on the task's branch", {
        worktreeId: facts.claim.worktree,
        error: errorText(error).slice(0, 500),
      });
    } finally {
      (opened as GitChildren | null)?.retire();
      this.pruneGitRegistries();
    }
  }

  private async prepareTaskBranchOn(repo: PinnedRepository, facts: DurableFacts, target: TaskWriteTarget): Promise<Decision<void>> {
    const worktree = facts.claim.worktree;
    const format = await objectFormatOf(repo);
    const { head, branch } = await headOf(repo);
    if (!head) return deny(ReasonCode.PROBE_FAILED, "the claimed worktree has no HEAD commit", { worktreeId: worktree });
    if ((await commitOf(repo, target.baseSha)) !== target.baseSha) {
      return deny(ReasonCode.CONFLICT, "the run's pinned base commit is not in the registered checkout", {
        worktreeId: worktree,
        baseSha: target.baseSha,
      });
    }
    const tip = await commitOf(repo, `refs/heads/${target.branch}`);
    if (tip !== null) {
      // c98ea8a3, review r2 (S-TB-03) — a name and a SHA are not ownership, and neither is an attempt: an
      // existing branch is this task's only when the control plane recorded completing its creation for
      // this run, task, repository, branch and base. One an attempt left without a completion is refused.
      const created = branchCreations(this.ports.db, facts.claim.repositoryIdentity, target.branch).some((creation) =>
        creation.runId === facts.runId && creation.taskId === facts.taskId && creation.baseSha === target.baseSha);
      if (!created) {
        const attempted = branchCreationAttempted(this.ports.db, {
          runId: facts.runId,
          taskId: facts.taskId,
          repositoryIdentity: facts.claim.repositoryIdentity,
          branch: target.branch,
          baseSha: target.baseSha,
        });
        return deny(
          ReasonCode.CONFLICT,
          attempted
            ? "a branch with the task's name exists, and the control plane's attempt to create it never completed; it is not adopted and is left as it is"
            : "a branch with the task's name exists that the control plane did not create for this run and task; it is left as it is",
          { worktreeId: worktree, branch: target.branch, tip, baseSha: target.baseSha, creationAttempted: attempted },
        );
      }
      const lineage = await this.taskBranchLineage(repo, facts, target, tip);
      if (!lineage.allowed) return lineage;
    }
    // Review r3 (S-TB-07) — an earlier attempt that never resolved (its own records failed, or something
    // of it could not be put back) is not attempted again on the control plane's own: it is refused by name.
    if (tip === null) {
      const scope = { runId: facts.runId, taskId: facts.taskId, repositoryIdentity: facts.claim.repositoryIdentity, branch: target.branch, baseSha: target.baseSha };
      if (unresolvedCreationAttempt(this.ports.db, scope)) {
        return deny(
          ReasonCode.CONFLICT,
          "an earlier attempt to create the task's branch never resolved; the control plane does not attempt it again on its own",
          { worktreeId: worktree, branch: target.branch, baseSha: target.baseSha, creationAttempted: true },
        );
      }
    }
    // Re-entry: the checkout is on the task's branch already; the preparation that follows reads it.
    if (branch === target.branch) return allow(ReasonCode.OK, undefined);
    let handoff: { runId: string; taskId: string; branch: string } | null = null;
    if (branch !== facts.claim.baseBranch) {
      const previous = branch === null ? null : this.finishedTaskBranch(facts, branch);
      if (!previous) {
        return deny(
          ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
          "the registered checkout is on neither the task's branch, the run's base branch, nor a branch the control plane made for a task; the control plane does not move it",
          { worktreeId: worktree, branch: target.branch, baseBranch: facts.claim.baseBranch, observed: branch },
        );
      }
      if (!previous.allowed) return previous as Decision<never>;
      handoff = previous.value;
    }
    const unclean = await uncleanPaths(repo, head, format, "branch");
    if (unclean.length > 0) {
      return deny(
        ReasonCode.CONFLICT,
        "the registered checkout holds uncommitted changes; the task's branch is made only from a clean checkout, and the control plane never resets or cleans one",
        { worktreeId: worktree, paths: unclean.slice(0, 50) },
      );
    }
    const indexBaseline = await stagedContent(repo, indexSnapshot(repo, "branch-index"));
    const to = tip ?? target.baseSha;
    const needsCheckout = (await commitOf(repo, `${head}^{tree}`)) !== (await commitOf(repo, `${to}^{tree}`));
    if (needsCheckout) {
      const filters = await runPinnedGit(repo, ["config", "--get-regexp", "^filter\\."]);
      if (filters.exitCode !== 1) {
        return deny(
          ReasonCode.CONFLICT,
          "the registered checkout configures a filter driver; the control plane does not run one to check out the task's branch",
          { worktreeId: worktree, exitCode: filters.exitCode },
        );
      }
    }
    const effect: { outcome: Decision<void> } = {
      outcome: deny(ReasonCode.INTERNAL_ERROR, "the task branch effect did not run", { worktreeId: worktree }),
    };
    // One attempt's records (intent, completion or verified undo) carry the same id.
    const attemptId = randomUUID();
    const authorised = await this.ports.guard.authorize(
      {
        operation: WriteOperation.GIT_BRANCH,
        targetPath: worktree,
        repositoryIdentity: facts.claim.repositoryIdentity,
        targetBranch: target.branch,
        targetWorktreeId: worktree,
        taskId: facts.taskId,
        runId: facts.runId,
        sessionId: facts.ownerSessionId,
        sessionIncarnation: facts.ownerSessionIncarnation,
        bindingGeneration: facts.ownerBindingGeneration,
        actor: "task-branch",
      },
      async () => {
        effect.outcome = await switchToTaskBranch(repo, {
          head,
          branch: branch!,
          tip,
          to,
          target,
          format,
          needsCheckout,
          indexBaseline,
          attemptId,
          // The intent, written immediately before the create-only ref update, and the completion,
          // written only once the branch exists at the pin and the checkout stands clean on it.
          recordCreation: (kind: CreationRecordKind) => this.ports.audit.record({
            kind,
            runId: facts.runId,
            sessionId: facts.ownerSessionId,
            evidence: {
              taskId: facts.taskId,
              repositoryIdentity: facts.claim.repositoryIdentity,
              branch: target.branch,
              baseSha: target.baseSha,
              worktreeId: worktree,
              attemptId,
            },
          }),
        });
      },
    );
    if (!authorised.allowed) return authorised as Decision<never>;
    if (!effect.outcome.allowed) return effect.outcome;
    // Evidence only, never read as ownership: a failure to write it does not refuse a branch made and recorded.
    try {
      this.ports.audit.record({
        kind: TASK_BRANCH_PREPARED,
        runId: facts.runId,
        sessionId: facts.ownerSessionId,
        evidence: {
          taskId: facts.taskId,
          claimId: facts.claim.claimId,
          repositoryIdentity: facts.claim.repositoryIdentity,
          worktreeId: worktree,
          branch: target.branch,
          baseSha: target.baseSha,
          head: to,
          from: head,
          fromBranch: branch,
          created: tip === null,
          checkedOut: needsCheckout,
          handoffFrom: handoff,
        },
      });
    } catch {
      /* the completion record stands; PREPARED is a report */
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * c98ea8a3 (S-TB-02) — the hand-off from a finished task's branch: the checkout may leave `branch`
   * for the next task's branch only when the control plane recorded creating `branch` for a task in
   * this repository, and that task's executions have all ended with no worker process outstanding.
   * Its ref and commits are left exactly where they are. Null when `branch` is no such branch.
   */
  private finishedTaskBranch(facts: DurableFacts, branch: string): Decision<{ runId: string; taskId: string; branch: string }> | null {
    const creation = branchCreations(this.ports.db, facts.claim.repositoryIdentity, branch).at(-1);
    if (!creation) return null;
    const unfinished = this.ports.db.get<{ execution_id: string }>(
      `SELECT execution_id FROM task_executions
        WHERE task_id = ? AND (status = 'RUNNING' OR (worker_process_id IS NOT NULL AND worker_process_released_at IS NULL))
        ORDER BY execution_id LIMIT 1`,
      [creation.taskId],
    );
    if (unfinished) {
      return deny(ReasonCode.CONFLICT, "the checkout is on an earlier task's branch whose execution has not ended; it is not moved", {
        worktreeId: facts.claim.worktree,
        observed: branch,
        previousTaskId: creation.taskId,
        executionId: unfinished.execution_id,
      });
    }
    return allow(ReasonCode.OK, { runId: creation.runId, taskId: creation.taskId, branch });
  }

  /** An existing branch of the task's name descends from the pinned base, and past it holds only this task's commits. */
  private async taskBranchLineage(repo: PinnedRepository, facts: DurableFacts, target: TaskWriteTarget, tip: string): Promise<Decision<void>> {
    if (tip === target.baseSha) return allow(ReasonCode.OK, undefined);
    const ancestor = await runPinnedGit(repo, ["merge-base", "--is-ancestor", target.baseSha, tip]);
    if (ancestor.exitCode === 1) {
      return deny(ReasonCode.CONFLICT, "a branch with the task's name does not descend from the run's pinned base; it is left as it is", {
        branch: target.branch,
        tip,
        baseSha: target.baseSha,
      });
    }
    const listed = ancestor.exitCode === 0 ? await runPinnedGit(repo, ["rev-list", `${target.baseSha}..${tip}`]) : null;
    if (!listed || listed.exitCode !== 0) {
      return deny(ReasonCode.PROBE_FAILED, "the task branch's history could not be read", { branch: target.branch, tip });
    }
    const ours = new Set(
      this.ports.db
        .all<{ head: string | null }>(
          `SELECT json_extract(evidence_json, '$.commitHead') AS head FROM audit_events
            WHERE run_id = ? AND kind IN (${Object.values(WorkerTurnEvent).map(() => "?").join(", ")})
              AND json_extract(evidence_json, '$.taskId') = ?`,
          [facts.runId, ...Object.values(WorkerTurnEvent), facts.taskId],
        )
        .map((row) => row.head)
        .filter((head): head is string => typeof head === "string"),
    );
    const foreign = listed.stdout.split("\n").filter((commit) => commit.length > 0 && !ours.has(commit));
    if (foreign.length > 0) {
      return deny(ReasonCode.CONFLICT, "a branch with the task's name carries commits this task's turns did not make; it is left as it is", {
        branch: target.branch,
        tip,
        foreign: foreign.slice(0, 20),
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  private async execute(
    adapter: ProviderAdapter,
    facts: TurnFacts,
    executionId: string,
    timeoutMs: number,
    inFlight: InFlightTurn,
  ): Promise<void> {
    const controller = inFlight.controller;
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
      // Stopped between admission and launch (a shutdown, a cancel or a takeover): nothing is launched.
      if (controller.signal.aborted) throw new Error("the turn was stopped before its provider was launched");
      result = await adapter.invoke({
        prompt: workerPrompt(facts),
        workdir: facts.claim.worktree,
        timeoutMs,
        model: facts.worker.model,
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
          // A provider that starts after its turn was stopped is never recorded, so the adapter kills it.
          if (controller.signal.aborted || this.#stopping) throw new Error("the turn was stopped before its provider started");
          const recorded = this.ports.tasks.recordWorkerProcess(
            executionId, pid, startedAt,
            new WorkerProcessAuthorityToken(this.ports.db, "record", { executionId, pid, startedAt }),
          );
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

    // The process this turn launched must be gone before anything it may have written is read.
    const processGone = await this.settleProcess(executionId);
    try {
      await this.conclude(facts, executionId, { result, thrown, spawned, timedOut, stopped, processGone, stopping: inFlight.stopping });
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
    turn: {
      result: InvocationResult | null;
      thrown: string | null;
      spawned: boolean;
      timedOut: boolean;
      stopped: boolean;
      processGone: boolean;
      stopping: boolean;
    },
  ): Promise<void> {
    const { result } = turn;
    const stdoutSha256 = result ? sha256(result.stdout ?? result.text) : null;
    const base = {
      exitCode: result?.exitCode ?? null,
      stdoutSha256,
      providerSessionId: result?.providerSessionId ?? null,
      spawned: turn.spawned,
      processGone: turn.processGone,
      error: (result?.error ?? turn.thrown)?.slice(0, 500) ?? null,
    };
    // Observed for every outcome whose writer is gone, so a failure keeps the digest of whatever the
    // turn left behind. A writer that may still be running is not read at all.
    const observed = turn.spawned && turn.processGone ? await this.observe(facts) : null;
    const diffDigest = observed?.diffDigest ?? null;
    // #1097 — a change under an ignored path is never committed; it is named here, whatever the outcome.
    const ignoredChanges = observed ? await ignoredChangesOf(facts) : null;
    const evidence = {
      ...base,
      diffDigest,
      paths: observed?.entries.map((entry) => entry.path) ?? [],
      ...(ignoredChanges ? { ignoredChanges } : {}),
    };

    if (!this.isRunning(executionId)) {
      this.refuseLate(facts, executionId, { ...evidence, reason: "EXECUTION_NO_LONGER_RUNNING" });
      return;
    }
    if (turn.stopping || this.#stopping) {
      this.fail(facts, executionId, "ABANDONED", "infrastructure", { ...evidence, reason: "DAEMON_STOPPING", reasonCode: ReasonCode.INTERNAL_ERROR });
      return;
    }
    if (!turn.processGone) {
      this.fail(facts, executionId, "FAILED", "infrastructure", {
        ...evidence,
        reason: "PROCESS_OUTSTANDING",
        reasonCode: ReasonCode.INTERNAL_ERROR,
      });
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
    // #1104 — the turn's own process group was not confirmed ended: not a completion, and the group is named.
    if (result.processGroup !== undefined) {
      this.fail(facts, executionId, "FAILED", "infrastructure", {
        ...evidence,
        reason: "PROCESS_GROUP_UNCONFIRMED",
        reasonCode: ReasonCode.INTERNAL_ERROR,
        processGroup: result.processGroup,
      });
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
    if (!committed.ok && this.authorityFor(executionId).allowed === false) {
      // Authority went while the commit was being made: the live fence refused it (nothing committed)
      // or something after it failed. Either way the turn ends with the daemon, never FAILED on its own.
      this.endWithoutAuthority(facts, executionId, {
        ...evidence,
        detail: committed.message,
        commitReason: committed.reason,
        commitHead: committed.head,
      });
      return;
    }
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

    // SUCCEEDED only now, after the commit, bound to its exact HEAD — and in one transaction with the
    // evidence its digest is computed from (ACP-WORKER-02): if that evidence cannot be stored, the
    // receipt is not finished SUCCEEDED either.
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
    // A holder, not a `let`: the transaction body assigns it, and a narrowed local would hide that.
    const step: { failedAt: "authority" | "finish" | "evidence" | null } = { failedAt: null };
    let finished: Decision<unknown>;
    try {
      finished = this.ports.db.txDecision(() => {
        // ACP-WORKER-03: asked inside the transaction that would write SUCCEEDED, and nowhere earlier
        // that a later await could make stale.
        const authority = this.authorityFor(executionId);
        if (!authority.allowed) {
          step.failedAt = "authority";
          return authority;
        }
        const done = this.ports.tasks.finishExecution(executionId, { status: "SUCCEEDED", resultDigest }, facts.runId);
        if (!done.allowed) {
          step.failedAt = "finish";
          return done;
        }
        const recorded = this.ports.audit.record({
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
            // #1097 — a finding, not an input of the digest: what the turn changed that was not committed.
            ...(ignoredChanges ? { ignoredChanges } : {}),
          },
        });
        if (!recorded.allowed) {
          step.failedAt = "evidence";
          return recorded;
        }
        return done;
      });
    } catch (error) {
      step.failedAt = step.failedAt ?? "evidence";
      finished = deny(ReasonCode.AUDIT_WRITE_FAILED, "the success evidence could not be written", { error: errorText(error).slice(0, 300) });
    }
    if (finished.allowed) return;
    if (step.failedAt === "authority") {
      // The commit exists; success is not written for it once authority is gone.
      this.endWithoutAuthority(facts, executionId, { ...evidence, commitHead: committed.head });
      return;
    }
    if (step.failedAt === "finish") {
      this.refuseLate(facts, executionId, {
        ...evidence,
        reason: "FINISH_REFUSED_AFTER_COMMIT",
        reasonCode: finished.reasonCode,
        commitHead: committed.head,
      });
      return;
    }
    this.fail(facts, executionId, "FAILED", "infrastructure", {
      ...evidence,
      reason: "SUCCESS_EVIDENCE_NOT_RECORDED",
      reasonCode: finished.reasonCode,
      commitHead: committed.head,
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
        const committed = await this.#commit.commit(facts.repo, {
          baseHead: facts.baseHead,
          branch: facts.claim.branch,
          entries: first.entries,
          message: commitMessage(facts),
          format: facts.objectFormat,
          stagedBaseline: facts.stagedBaseline,
          stillAuthorized: () => this.authorityFor(executionId),
        });
        if (!committed.allowed) {
          const head = typeof committed.evidence["head"] === "string" ? committed.evidence["head"] : null;
          state.outcome = {
            ok: false,
            reason: "COMMIT_FAILED",
            reasonCode: committed.reasonCode,
            message: committed.message,
            head,
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
    const repo = facts.repo;
    if ((await parentOf(repo, head)) !== facts.baseHead) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the commit's parent is not the turn's base", { head });
    }
    const committed = await committedChanges(repo, facts.baseHead, head);
    const expected = first.entries.map((entry) => `${entry.path}\0${entry.mode ?? "-"}\0${entry.blob ?? "-"}`).sort();
    const actual = committed.map((entry) => `${entry.path}\0${entry.mode ?? "-"}\0${entry.blob ?? "-"}`).sort();
    if (expected.join("\n") !== actual.join("\n")) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the commit differs from the verified change", { head });
    }
    const now = await headOf(repo);
    if (now.head !== head || now.branch !== facts.claim.branch) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the branch does not name the worker commit", { head });
    }
    const left = await scanAgainst(repo, head, facts.objectFormat, "verify");
    if (left.entries.length > 0 || left.unsafe.length > 0) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the worktree still differs from the commit", { head });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * The worktree after a turn, relative to its base. Before git is asked anything, the `.git` entry
   * and every file of the pinned git dirs are compared with the filesystem against the pre-turn
   * baseline; then the effective configuration is compared too. Any difference refuses the turn: a
   * worker that rewrote a config, an include target, a hook or the `.git` indirection never gets a
   * git command run under it.
   */
  private async observe(facts: TurnFacts): Promise<Observation> {
    const refused = (reason: string, reasonCode: ReasonCode, message: string): Observation => ({
      problem: { reason, reasonCode, message },
      entries: [],
      diffDigest: null,
      outOfScope: [],
      agentConfiguration: [],
    });
    const repo = facts.repo;
    try {
      if (dotGitFingerprint(repo.workTree) !== repo.dotGit) {
        return refused("GIT_INDIRECTION_CHANGED", ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the worktree's .git entry changed during the turn");
      }
      if (gitDirFingerprint(repo) !== facts.gitDirFingerprint) {
        return refused("GIT_DIR_CHANGED", ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "a file of the git dir changed during the turn");
      }
      if ((await effectiveConfig(repo)) !== facts.config) {
        return refused("GIT_CONFIG_CHANGED", ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the repository's effective git configuration changed during the turn");
      }
      const now = await headOf(repo);
      if (now.head !== facts.baseHead || now.branch !== facts.claim.branch) {
        return refused("HEAD_MOVED", ReasonCode.WRITE_EFFECT_FENCE_LOST, "HEAD or the branch moved during the turn");
      }
      // ACP-WORKER-06: someone staged, unstaged or marked an entry during the turn. A stat-cache refresh
      // (the CLI's own `git status`) changes nothing here; staged work is never folded in or overwritten.
      if ((await stagedContent(repo)) !== facts.stagedBaseline) {
        return refused("STAGED_CONTENT_CHANGED", ReasonCode.WRITE_EFFECT_FENCE_LOST, "the index's staged content changed during the turn");
      }
      const scan = await scanAgainst(repo, facts.baseHead, facts.objectFormat, "observe");
      const outOfScope = new Set<string>(scan.unsafe);
      const agentConfiguration = new Set<string>(scan.untrackedAgentConfiguration);
      for (const entry of scan.entries) {
        if (isAgentConfiguration(entry.path)) agentConfiguration.add(entry.path);
        if (!insideOwned(entry.path, facts.claim.ownedPaths)) outOfScope.add(entry.path);
      }
      for (const path of agentConfiguration) outOfScope.add(path);
      return {
        problem: null,
        entries: scan.entries,
        diffDigest: scan.entries.length > 0 ? workerDiffDigest(facts.baseHead, scan.entries) : null,
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

  /** The recorded process and every member of its group are gone, or its pid now names another process. */
  private confirmedGone(pid: number, startedAt: string | null): boolean {
    if (this.#processes.groupAlive(pid)) return false;
    if (!this.#processes.alive(pid)) return true;
    const now = this.#processes.startToken(pid);
    return startedAt !== null && now !== null && now !== startedAt;
  }

  /**
   * Confirms the recorded process gone and, only then, records it released under an authority minted
   * here for that one execution, pid and start time (#1070). Returns whether the process is gone; a
   * release the database refuses leaves it outstanding, which only ever blocks a retry.
   */
  private releaseIfGone(executionId: string, pid: number, startedAt: string | null): boolean {
    if (!this.confirmedGone(pid, startedAt)) return false;
    this.ports.tasks.releaseWorkerProcess(executionId, new WorkerProcessAuthorityToken(this.ports.db, "release", { executionId, pid, startedAt }));
    return true;
  }

  /**
   * Whether a live pid is, right now, the process this execution launched (#1070) — asked immediately
   * before any kill. The OS start time it reports must be the recorded one, and its command line must
   * carry this execution's worker session as the argv element after `--session-id` (Claude) or
   * `--thread-source` (Codex). A pid whose start time or command line cannot be read is not confirmed,
   * and nothing that is not confirmed is killed: it stays outstanding and blocks its task instead.
   */
  private ownershipOf(executionId: string, pid: number, startedAt: string | null): ProcessOwnership {
    const now = this.#processes.alive(pid) ? this.#processes.startToken(pid) : null;
    if (startedAt === null || now === null || now !== startedAt) return "START_TIME_NOT_CONFIRMED";
    const session = this.ports.db.get<{ incarnation: string }>(
      `SELECT s.incarnation FROM task_executions e JOIN sessions s ON s.session_id = e.worker_session_id
        WHERE e.execution_id = ? AND e.runtime_managed = 1`,
      [executionId],
    );
    const expected = session?.incarnation.split("#", 1)[0] ?? "";
    const argv = this.#processes.argv(pid);
    if (expected === "" || argv === null) return "COMMAND_LINE_NOT_CONFIRMED";
    for (let index = 0; index + 1 < argv.length; index += 1) {
      const flag = argv[index];
      if ((flag === "--session-id" || flag === "--thread-source") && argv[index + 1] === expected) return "OWNED";
    }
    return "COMMAND_LINE_NOT_CONFIRMED";
  }

  private async waitGone(pid: number, startedAt: string | null, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (this.confirmedGone(pid, startedAt)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(20);
    }
  }

  /**
   * After the provider call returns, its process is confirmed gone — waited for, then its group killed
   * (this runner launched it), then waited for again — and only then released. One that will not go
   * stays outstanding.
   */
  private async settleProcess(executionId: string): Promise<boolean> {
    const execution = this.ports.tasks.execution(executionId);
    const pid = execution?.workerProcessId ?? null;
    if (!execution || pid === null) return true;
    if (execution.workerProcessReleasedAt !== null) return true;
    const startedAt = execution.workerProcessStartedAt;
    let gone = await this.waitGone(pid, startedAt, this.#processSettleMs);
    if (!gone) {
      // Only a process positively confirmed as this execution's is killed; any other stays outstanding.
      if (this.ownershipOf(executionId, pid, startedAt) === "OWNED") this.#processes.killGroup(pid);
      gone = await this.waitGone(pid, startedAt, this.#processSettleMs);
    }
    if (gone) this.releaseIfGone(executionId, pid, startedAt);
    return gone;
  }

  /**
   * Ends the execution with its diagnostics in one transaction. If the full diagnostics cannot be
   * stored, the reason alone is; the execution is never left RUNNING for want of an audit row, and
   * never carries a success digest.
   */
  private fail(
    facts: TurnFacts,
    executionId: string,
    status: "FAILED" | "TIMEOUT" | "ABANDONED",
    failureClass: FailureClass,
    evidence: Record<string, unknown>,
  ): void {
    const attempt = (diagnostics: Record<string, unknown> | null): { stage: "finish" | "evidence" | null; decision: Decision<unknown> } => {
      const step: { stage: "finish" | "evidence" | null } = { stage: null };
      try {
        const decision = this.ports.db.txDecision(() => {
          const finished = this.ports.tasks.finishExecution(executionId, { status, failureClass, resultDigest: null }, facts.runId);
          if (!finished.allowed) {
            step.stage = "finish";
            return finished;
          }
          if (diagnostics === null) return finished;
          const recorded = this.ports.audit.record({
            kind: WorkerTurnEvent.FAILED,
            runId: facts.runId,
            sessionId: facts.worker.sessionId,
            roleKey: facts.worker.roleKey,
            reasonCode: (diagnostics["reasonCode"] as ReasonCode | undefined) ?? null,
            evidence: { executionId, taskId: facts.taskId, status, failureClass, ...diagnostics } as Evidence,
          });
          if (!recorded.allowed) {
            step.stage = "evidence";
            return recorded;
          }
          return finished;
        });
        return { stage: step.stage, decision };
      } catch (error) {
        return { stage: step.stage ?? "evidence", decision: deny(ReasonCode.AUDIT_WRITE_FAILED, errorText(error).slice(0, 300), {}) };
      }
    };
    const full = attempt(evidence);
    if (full.decision.allowed) return;
    if (full.stage === "finish") {
      this.refuseLate(facts, executionId, { ...evidence, attemptedStatus: status, finishReasonCode: full.decision.reasonCode });
      return;
    }
    const minimal = attempt({
      reason: evidence["reason"] ?? "UNKNOWN",
      reasonCode: evidence["reasonCode"] ?? null,
      diagnosticsRejected: full.decision.reasonCode,
    });
    if (minimal.decision.allowed) return;
    attempt(null);
  }

  /** A result for an execution that is no longer RUNNING is refused, and recorded with its diagnostics. */
  /**
   * The live authority fence (ACP-WORKER-03), read at the moment of an irreversible step and never
   * copied: the runner is not stopping, and the execution is still RUNNING in the database — which a
   * drain that timed out has already, durably, ended before the daemon released its authority.
   */
  private authorityFor(executionId: string): Decision<void> {
    if (this.#stopping) {
      return deny(ReasonCode.CONFLICT, "the daemon is stopping; a worker turn commits and succeeds nothing now", { executionId });
    }
    if (!this.isRunning(executionId)) {
      return deny(ReasonCode.CONFLICT, "the execution is no longer running", { executionId });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** A turn whose authority went before it could finish: ABANDONED with the daemon, or refused as late. */
  private endWithoutAuthority(facts: TurnFacts, executionId: string, evidence: Record<string, unknown>): void {
    if (this.isRunning(executionId)) {
      this.fail(facts, executionId, "ABANDONED", "infrastructure", { ...evidence, reason: "DAEMON_STOPPING", reasonCode: ReasonCode.INTERNAL_ERROR });
    } else {
      this.refuseLate(facts, executionId, { ...evidence, reason: "AUTHORITY_WITHDRAWN" });
    }
  }

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
    const kinds = Object.values(WorkerTurnEvent);
    return this.ports.db
      .all<{ kind: string; evidence_json: string }>(
        `SELECT kind, evidence_json FROM audit_events
          WHERE run_id = ? AND kind IN (${kinds.map(() => "?").join(", ")})
            AND json_extract(evidence_json, '$.executionId') = ?
          ORDER BY event_id`,
        [runId, ...kinds, executionId],
      )
      .map((row) => ({ kind: row.kind, evidence: JSON.parse(row.evidence_json) as Evidence }));
  }

  /**
   * An earlier turn of this task whose recorded process is not confirmed gone. One that is gone by now
   * is released here, durably; one that may still live keeps the task from another turn.
   */
  private outstandingProcess(taskId: string): { executionId: string; pid: number } | null {
    const rows = this.ports.db.all<{ execution_id: string; worker_process_id: number; worker_process_started_at: string | null }>(
      `SELECT execution_id, worker_process_id, worker_process_started_at FROM task_executions
        WHERE task_id = ? AND worker_process_id IS NOT NULL AND worker_process_released_at IS NULL
        ORDER BY execution_id`,
      [taskId],
    );
    for (const row of rows) {
      if (this.releaseIfGone(row.execution_id, row.worker_process_id, row.worker_process_started_at)) continue;
      return { executionId: row.execution_id, pid: row.worker_process_id };
    }
    return null;
  }

  /**
   * An earlier turn of this task that may have launched a process never recorded: no pid to confirm gone.
   * #1096 — one the operator's repair has since released no longer blocks, and only as far as
   * `orphanResolutionVerified` verifies that repair's own durable release record for exactly this orphan
   * event; a resolution row the audit API wrote is never enough. The orphan row itself is never removed.
   */
  private blockedOrphan(taskId: string): { executionId: string; eventId: number } | null {
    const [first] = unresolvedUnidentifiedOrphans(this.ports.db, { taskId });
    return first === undefined ? null : { executionId: first.executionId, eventId: first.eventId };
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

/** #1097 — `ignoredPathState`, with a failure kept as its error. */
/** #512 S-TB — the audit kind for a task branch the control plane created or checked out. */
export const TASK_BRANCH_PREPARED = "TASK_BRANCH_PREPARED";

const ZERO_OID = { sha1: "0".repeat(40), sha256: "0".repeat(64) } as const;

/** The commit (or tree) an expression names in the pinned repository, or null when it names none. */
const commitOf = async (repo: PinnedRepository, expression: string): Promise<string | null> => {
  const read = await runPinnedGit(repo, ["rev-parse", "--verify", "-q", expression.endsWith("^{tree}") ? expression : `${expression}^{commit}`]);
  const value = read.stdout.trim();
  return read.exitCode === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null;
};

/** What a checkout holds that its HEAD does not: staged entries, changed or untracked paths, and what cannot be vouched for. */
const uncleanPaths = async (repo: PinnedRepository, head: string, format: "sha1" | "sha256", label: string): Promise<string[]> => {
  const snapshot = indexSnapshot(repo, label);
  const staged = await stagedAgainst(repo, head, snapshot);
  const scan = await scanAgainst(repo, head, format, label);
  return [...new Set([
    ...staged,
    ...scan.entries.map((entry) => entry.path),
    ...scan.unsafe,
    ...scan.populatedGitlinks,
    ...scan.untrackedAgentConfiguration,
  ])];
};

type CreationRecordKind = typeof TASK_BRANCH_CREATING | typeof TASK_BRANCH_CREATED | typeof TASK_BRANCH_CREATION_UNDONE;

/** One undo step that did not do what it was for: the step, git's (or the store's) own words, and where that leaves the checkout. */
interface UndoBlocker {
  step: "head-back" | "files-back" | "head-forward" | "ref-delete" | "recovery incomplete" | "completion" | "undo";
  error: string;
  state: string;
  paths?: string[];
}

const gitWords = (run: GitRun): string => `exit ${run.exitCode ?? "none"}: ${(run.stderr || run.stdout).trim().slice(0, 300)}`;

/** The ref HEAD names, or null when HEAD is detached or cannot be read. */
const headRefOf = async (repo: PinnedRepository): Promise<string | null> => {
  const read = await runPinnedGit(repo, ["symbolic-ref", "-q", "HEAD"]);
  return read.exitCode === 0 ? read.stdout.trim() : null;
};

/** Each path's mode and object id in `tree`, for the paths asked; a path the tree lacks is absent. */
const treeEntriesOf = async (repo: PinnedRepository, tree: string, paths: readonly string[]): Promise<Map<string, { mode: string; oid: string }>> => {
  const entries = new Map<string, { mode: string; oid: string }>();
  if (paths.length === 0) return entries;
  const listed = await runPinnedGit(repo, ["ls-tree", "-z", "--full-tree", tree, "--", ...paths]);
  if (listed.exitCode !== 0) throw new Error(`git ls-tree ${tree} ${gitWords(listed)}`);
  for (const record of listed.stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, , oid] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode: mode!, oid: oid! });
  }
  return entries;
};

/** One path a refused read-tree may have moved: what `from` holds, what the worktree holds now, what `dest` holds. */
interface RecoveryPath {
  path: string;
  /** The original: `from`'s entry, null where `from` has no such path. */
  expected: { mode: string; oid: string } | null;
  /** What the worktree holds when measured: a regular file or symlink's mode and blob, null where it is gone. */
  current: { mode: string; blob: string } | null;
  /** The destination's entry, null where `dest` has no such path. */
  destination: { mode: string; oid: string } | null;
}

/**
 * Review r3 (S-TB-07 b), CEO 363fae88 — after a two-tree `read-tree -m -u` from `from` to `dest` failed.
 * Git can have written some files before it stopped (it never writes the index then), so nothing is
 * assumed: what now differs from `from` is measured, and only measured. A path whose bytes and mode are
 * exactly `dest`'s (or that `dest` lacks and is gone) was moved by that read-tree; anything else is not
 * ours. Nothing is written here: putting a moved path back would race any concurrent write to it, and no
 * re-read or hash compare closes that window, so a moved path is left exactly as it is and reported.
 */
const measurePartialMove = async (
  repo: PinnedRepository,
  from: string,
  dest: string,
  format: "sha1" | "sha256",
  label: string,
): Promise<{ moved: RecoveryPath[]; notOurs: string[]; indexChanged: string[]; error: string | null }> => {
  try {
    const indexChanged = await stagedAgainst(repo, from, indexSnapshot(repo, `${label}-index`));
    const scan = await scanAgainst(repo, from, format, label);
    const paths = scan.entries.map((entry) => entry.path);
    const wanted = await treeEntriesOf(repo, dest, paths);
    const original = await treeEntriesOf(repo, from, paths);
    const moved: RecoveryPath[] = [];
    const notOurs: string[] = [...scan.unsafe];
    for (const entry of scan.entries) {
      const destination = wanted.get(entry.path) ?? null;
      const ours = destination === null ? entry.mode === null : entry.blob === destination.oid && entry.mode === destination.mode;
      if (!ours) {
        notOurs.push(entry.path);
        continue;
      }
      moved.push({
        path: entry.path,
        expected: original.get(entry.path) ?? null,
        current: entry.mode === null || entry.blob === null ? null : { mode: entry.mode, blob: entry.blob },
        destination,
      });
    }
    return { moved, notOurs, indexChanged: indexChanged.slice(0, 50), error: null };
  } catch (failure) {
    return { moved: [], notOurs: [], indexChanged: [], error: `the checkout could not be measured: ${errorText(failure).slice(0, 300)}` };
  }
};

/**
 * The GIT_BRANCH effect, run inside the guard's grant (review r2 S-TB-03 and S-TB-07; review r3 S-TB-07,
 * CEO bb10228a 07). Every check that can refuse comes before the first write:
 *
 * 1. HEAD, the worktree and the index are as they were read: clean, nothing staged anew.
 * 2. Where files must move, the index's stat cache is refreshed; a file changed since step 1 refuses here.
 * 3. A missing branch's intent is recorded, it is created create-only at the pinned base and read back.
 * 4. Files move by a two-tree `read-tree -m -u`; then HEAD names the branch, and the checkout must stand
 *    on it at the expected commit, clean.
 * 5. Only then is the creation recorded complete (`TASK_BRANCH_CREATED`).
 *
 * A refusal or a throw after the first write goes through one undo, step by step, each step only when its
 * own precondition is verified first: HEAD is moved back only while it still names the task branch this
 * attempt set (someone else's choice is left alone); files are moved back only once HEAD is back, by the
 * reverse `read-tree`, whose own partial failure is measured and never put back (CEO 363fae88: recovery is
 * then incomplete, and reported path by path); the ref is deleted only if this
 * attempt created it, nothing stands on it and it still points at the pinned base (`update-ref -d` with
 * that old value). A step that fails, or is not taken because its precondition does not hold, is a named
 * blocker in the refusal with git's words and the state it leaves; nothing claims a rollback that did not
 * happen. Where files cannot go back without overwriting a change, HEAD follows them onto the task branch,
 * so the checkout stays consistent, and the branch is recorded created. A fully verified undo is recorded
 * (`TASK_BRANCH_CREATION_UNDONE`) so a later attempt may start afresh; an attempt whose own records
 * failed, or that left anything behind, stays unresolved and is not attempted again on its own.
 */
const switchToTaskBranch = async (
  repo: PinnedRepository,
  input: {
    head: string;
    branch: string;
    tip: string | null;
    to: string;
    target: TaskWriteTarget;
    format: "sha1" | "sha256";
    needsCheckout: boolean;
    /** `stagedContent` of the real index when the checkout was read clean. */
    indexBaseline: string;
    recordCreation: (kind: CreationRecordKind) => Decision<number>;
    /** The id this attempt's records carry; named in a recovery that could not complete. */
    attemptId: string;
  },
): Promise<Decision<void>> => {
  const branchRef = `refs/heads/${input.target.branch}`;
  const refused = (message: string, evidence: Record<string, unknown> = {}): Decision<never> =>
    deny(ReasonCode.CONFLICT, message, { branch: input.target.branch, ...evidence });
  /** A record write, its throw turned into a refusal: the store failing is one more failure to undo. */
  const record = (kind: CreationRecordKind): Decision<number> => {
    try {
      return input.recordCreation(kind);
    } catch (error) {
      return deny(ReasonCode.AUDIT_WRITE_FAILED, `the ${kind} record could not be written: ${errorText(error).slice(0, 300)}`, {});
    }
  };
  const now = await headOf(repo);
  if (now.head !== input.head || now.branch !== input.branch) {
    return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the checkout moved before the task's branch was made", { branch: input.target.branch });
  }
  // c98ea8a3 (S-TB-07) — clean, and the index as it was read, asserted again here at the effect and
  // before any write: a change that landed after the first reading refuses with nothing moved.
  const unclean = await uncleanPaths(repo, input.head, input.format, "branch-effect");
  if (unclean.length > 0 || (await stagedContent(repo, indexSnapshot(repo, "branch-effect-index"))) !== input.indexBaseline) {
    return refused(
      "the registered checkout changed before its task branch was made; nothing was created or moved, and the change is left where it is",
      { paths: unclean.slice(0, 50) },
    );
  }
  if (input.needsCheckout) {
    // The index's stat cache can be stale where the control plane's own commit updated entries without
    // one (`plumbingWorkerCommit`); `read-tree -m` refuses an entry it cannot see is up to date. The
    // refresh rewrites only that cache: the content was found clean above, and no filter driver is
    // configured, so nothing the repository chose runs while files are compared. Without `-q`, a file
    // whose content changed since then fails it ("needs update"), before anything is created.
    const refreshed = await runPinnedGit(repo, ["update-index", "--refresh"]);
    if (refreshed.exitCode !== 0) {
      return refused("the checkout's files changed before its task branch was made; nothing was created or moved", {
        error: (refreshed.stdout + refreshed.stderr).slice(0, 300),
      });
    }
  }

  // From here on, what this attempt did is undone on any refusal or throw.
  let createdHere = false;
  let filesMoved = false;
  let headMoved = false;
  const blockers: UndoBlocker[] = [];
  const undo = async (message: string, evidence: Record<string, unknown>, cause: "git" | "records"): Promise<Decision<never>> => {
    try {
      // 1. HEAD back, only while it still names the task branch this attempt set.
      let headElsewhere: string | null = null;
      if (headMoved) {
        const current = await headRefOf(repo);
        if (current !== branchRef) {
          headElsewhere = current ?? "a detached HEAD";
          blockers.push({
            step: "head-back",
            error: `HEAD names ${headElsewhere}, not the task branch this attempt set; it is not moved`,
            state: `HEAD is left on ${headElsewhere}; the files are ${filesMoved ? `at the task tree ${input.to}` : "as they were"}`,
          });
        } else {
          const back = await runPinnedGit(repo, ["symbolic-ref", "-m", "agent-control-plane: task branch undone", "HEAD", `refs/heads/${input.branch}`]);
          if (back.exitCode === 0) {
            headMoved = false;
          } else {
            blockers.push({
              step: "head-back",
              error: gitWords(back),
              state: `HEAD still names the task branch at ${input.to}; the files are ${filesMoved ? "at the task tree" : "as they were"}`,
            });
          }
        }
      }
      // 2. Files back, only once HEAD is back on the branch it left.
      let reverseRefused: string | null = null;
      let recovery: Record<string, unknown> | null = null;
      if (filesMoved && !headMoved && headElsewhere === null) {
        const reverse = await runPinnedGit(repo, ["read-tree", "-m", "-u", input.to, input.head]);
        if (reverse.exitCode === 0) {
          filesMoved = false;
        } else {
          reverseRefused = gitWords(reverse);
          const measured = await measurePartialMove(repo, input.to, input.head, input.format, "undo-reverse");
          if (measured.moved.length > 0 || measured.error !== null || measured.indexChanged.length > 0) {
            // CEO 363fae88: what the reverse read-tree moved is never put back; it is left exactly as it is.
            blockers.push({
              step: "recovery incomplete",
              error: `${reverseRefused}${measured.error === null ? "" : `; ${measured.error}`}`,
              state: `HEAD names ${input.branch} at ${input.head}; the index holds the task tree ${input.to}; the paths the reverse read-tree moved before it stopped are left exactly as they are, not put back`,
              paths: measured.moved.map((path) => path.path),
            });
            recovery = { attemptId: input.attemptId, from: input.to, to: input.head, paths: measured.moved, indexChanged: measured.indexChanged, notOurs: measured.notOurs.slice(0, 50) };
          } else {
            blockers.push({
              step: "files-back",
              error: reverseRefused,
              state: `the files stay at the task tree ${input.to}, with the change that stopped them; HEAD is put back on the task branch to match them`,
            });
            // Every file is still at the task tree: HEAD follows them, so the checkout is consistent there.
            const forward = await runPinnedGit(repo, ["symbolic-ref", "-m", "agent-control-plane: task branch", "HEAD", branchRef]);
            if (forward.exitCode === 0) {
              headMoved = true;
            } else {
              blockers.push({
                step: "head-forward",
                error: gitWords(forward),
                state: `HEAD names ${input.branch} at ${input.head} while the index and files are at the task tree ${input.to}`,
              });
            }
          }
        }
      }
      // 3. The ref this attempt created: removed only while nothing stands on it and it still points at the pin.
      let refRemoved = false;
      let refNowElsewhere: string | null = null;
      if (createdHere) {
        const current = await commitOf(repo, branchRef);
        const standsOnIt = filesMoved || (await headRefOf(repo)) === branchRef;
        if (current !== input.target.baseSha) {
          refNowElsewhere = current ?? "deleted";
        } else if (!standsOnIt && blockers.length === 0) {
          const removed = await runPinnedGit(repo, ["update-ref", "-m", "agent-control-plane: task branch undone", "-d", branchRef, input.target.baseSha]);
          if (removed.exitCode === 0) {
            refRemoved = true;
          } else {
            blockers.push({
              step: "ref-delete",
              error: gitWords(removed),
              state: `${branchRef} is left where it is (${(await commitOf(repo, branchRef)) ?? "deleted"})`,
            });
          }
        }
      }
      const leftOnBranch = createdHere && !refRemoved && refNowElsewhere === null && headMoved && (await headRefOf(repo)) === branchRef;
      if (leftOnBranch) {
        const done = record(TASK_BRANCH_CREATED);
        if (!done.allowed) {
          blockers.push({ step: "completion", error: done.message, state: "the checkout is on the task branch, which has no completion record and is not adopted" });
        }
      }
      const nothingKept = !createdHere || refRemoved || refNowElsewhere !== null;
      const rolledBack = blockers.length === 0 && !headMoved && !filesMoved && nothingKept;
      let undoRecorded = false;
      if (rolledBack && cause === "git") undoRecorded = record(TASK_BRANCH_CREATION_UNDONE).allowed;
      return refused(message, {
        ...evidence,
        created: createdHere,
        refRemoved,
        leftOnBranch,
        headMoved,
        filesMoved,
        rolledBack,
        undoRecorded,
        ...(refNowElsewhere === null ? {} : { refNowElsewhere }),
        ...(reverseRefused === null ? {} : { reverseRefused }),
        ...(recovery === null ? {} : { recovery }),
        blockers,
      });
    } catch (failure) {
      blockers.push({ step: "undo", error: errorText(failure).slice(0, 300), state: "the undo stopped where it was; the checkout was not measured after it" });
      return refused(message, { ...evidence, created: createdHere, headMoved, filesMoved, rolledBack: false, blockers });
    }
  };

  try {
    if (input.tip === null) {
      const intent = record(TASK_BRANCH_CREATING);
      if (!intent.allowed) return refused(`the task branch's creation could not be recorded before it was made; nothing was created: ${intent.message}`);
      const created = await runPinnedGit(repo, ["update-ref", "-m", "agent-control-plane: task branch", branchRef, input.target.baseSha, ZERO_OID[input.format]]);
      if (created.exitCode !== 0) {
        // Nothing of this attempt exists: the attempt is resolved, the ref there is someone else's.
        const resolved = record(TASK_BRANCH_CREATION_UNDONE).allowed;
        return refused("the task's branch could not be created; a ref that exists is never overwritten, nor adopted", {
          error: created.stderr.slice(0, 300),
          undoRecorded: resolved,
        });
      }
      createdHere = true;
      if ((await commitOf(repo, branchRef)) !== input.target.baseSha) {
        return await undo("the task's branch does not read back at the pinned base after its creation", {}, "git");
      }
    } else if ((await commitOf(repo, branchRef)) !== input.tip) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the task's branch moved before it was checked out", { branch: input.target.branch });
    }
    if (input.needsCheckout) {
      const moved = await runPinnedGit(repo, ["read-tree", "-m", "-u", input.head, input.to]);
      if (moved.exitCode !== 0) {
        // Review r3 (S-TB-07 b): never assume a refused read-tree moved nothing; measure it. CEO 363fae88: a
        // path it moved is never put back automatically (a concurrent write to it cannot be excluded), so if
        // anything moved, the files, the index, HEAD and the ref are all left exactly as they stand, and the
        // refusal carries what was measured. The attempt stays unresolved: no undo record is written.
        const measured = await measurePartialMove(repo, input.head, input.to, input.format, "forward-refused");
        if (measured.moved.length > 0 || measured.error !== null || measured.indexChanged.length > 0) {
          blockers.push({
            step: "recovery incomplete",
            error: `${gitWords(moved)}${measured.error === null ? "" : `; ${measured.error}`}`,
            state: `HEAD names ${input.branch} at ${input.head}; the index holds ${input.head}; ${createdHere ? `${branchRef} is kept at the pinned base, the moved files standing on it; ` : ""}the paths the read-tree moved before it stopped are left exactly as they are, not put back`,
            paths: measured.moved.map((path) => path.path),
          });
          return refused("the checkout's files could not be moved to the task's branch, and some had moved; recovery is incomplete and everything is left exactly as it stands", {
            error: moved.stderr.slice(0, 300),
            created: createdHere,
            refRemoved: false,
            leftOnBranch: false,
            headMoved: false,
            filesMoved: true,
            rolledBack: false,
            undoRecorded: false,
            recovery: { attemptId: input.attemptId, from: input.head, to: input.to, paths: measured.moved, indexChanged: measured.indexChanged, notOurs: measured.notOurs.slice(0, 50) },
            blockers,
          });
        }
        // Git refused before writing anything of ours: there is nothing to put back.
        return await undo("the checkout's files could not be moved to the task's branch; they are left as they were", {
          error: moved.stderr.slice(0, 300),
          ...(measured.notOurs.length > 0 ? { notOurs: measured.notOurs.slice(0, 50) } : {}),
        }, "git");
      }
      filesMoved = true;
    }
    const pointed = await runPinnedGit(repo, ["symbolic-ref", "-m", "agent-control-plane: task branch", "HEAD", branchRef]);
    if (pointed.exitCode !== 0) {
      return await undo("the checkout could not be put on the task's branch", { error: pointed.stderr.slice(0, 300) }, "git");
    }
    headMoved = true;
    const after = await headOf(repo);
    if (after.head !== input.to || after.branch !== input.target.branch) {
      return await undo("the checkout is not on the task's branch after it was made", { observed: after.branch, head: after.head }, "git");
    }
    const left = await uncleanPaths(repo, input.to, input.format, "branch-after");
    if (left.length > 0) {
      return await undo("the checkout changed while it was moved to the task's branch; the change is left where it is", { paths: left.slice(0, 50) }, "git");
    }
    if (createdHere) {
      const completed = record(TASK_BRANCH_CREATED);
      if (!completed.allowed) {
        return await undo("the task branch's creation could not be recorded complete", { reasonCode: completed.reasonCode, error: completed.message }, "records");
      }
    }
    return allow(ReasonCode.OK, undefined);
  } catch (failure) {
    // Review r3 (S-TB-07 c): a throw after the first write goes through the same undo.
    return await undo("an unexpected failure while the task's branch was made", { error: errorText(failure).slice(0, 300) }, "records");
  }
};

const readIgnored = async (repo: PinnedRepository, treeIsh: string, label: string): Promise<IgnoredReading> => {
  try {
    return { state: await ignoredPathState(repo, treeIsh, label), error: null };
  } catch (error) {
    return { state: null, error: errorText(error).slice(0, 300) };
  }
};

/**
 * #1097 — the ignored paths the turn created, changed or removed: the receipt's finding for work git
 * would otherwise drop without a word. A reading that failed, before or after, is reported as such.
 */
const ignoredChangesOf = async (facts: TurnFacts): Promise<{ paths: string[]; total: number; error: string | null }> => {
  const after = await readIgnored(facts.repo, facts.baseHead, "observe");
  if (facts.ignoredBaseline.state === null || after.state === null) {
    return { paths: [], total: 0, error: facts.ignoredBaseline.error ?? after.error };
  }
  const changed = ignoredPathsChanged(facts.ignoredBaseline.state, after.state);
  return { paths: changed.slice(0, IGNORED_CHANGES_NAMED), total: changed.length, error: null };
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
