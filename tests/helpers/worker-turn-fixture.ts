import Database from "better-sqlite3";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DynamicReserveDemand } from "../../src/capacity/capacity-monitor.ts";
import { ClaimRegistry } from "../../src/claims/claim-registry.ts";
import { type Clock, ManualClock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { newAssignmentId, newRepositoryId, newRunId, newSessionId } from "../../src/core/ids.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { Db } from "../../src/db/database.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ManagedWriteGuard } from "../../src/guard/managed-write-guard.ts";
import { realWorkspaceProbe } from "../../src/guard/workspace-probe.ts";
import { TaskGraph } from "../../src/run/task-graph.ts";
import {
  GuardedInvocationWriteBroker,
  type CapacityReading,
  type InvocationRequest,
  type InvocationResult,
  type ManagedInvocationWriteBroker,
  type ProviderAdapter,
  type SessionHandle,
} from "../../src/runtime/provider.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { BindingRegistry } from "../../src/session/binding-registry.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import { gitSync, makeRepo, tempDir } from "./fixtures.ts";

/**
 * #512 — one ACTIVE run whose PRIMARY_CTO owns it, one task, a WORKER bound the way PR-A binds one
 * (`BindingRegistry.bind({role: WORKER, sessionId, taskId, runId, projectId})` on its own READY
 * Claude/Opus session), and the CTO's claim on the run's worktree, branch and owned paths. Every row
 * is written through the production registries or the same raw SQL the shared fixtures use.
 *
 * Deliberately imports nothing from `src/run/worker-turn.ts`, so the guard and schema witnesses that use
 * it run unchanged against a tree that predates the runner.
 */
export interface WorkerWorld {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  tasks: TaskGraph;
  claims: ClaimRegistry;
  guard: ManagedWriteGuard;
  broker: ManagedInvocationWriteBroker;
  runId: string;
  projectId: string;
  repositoryId: string;
  identity: string;
  repoPath: string;
  /** The main checkout: `repoPath` itself, or the repository a linked `repoPath` belongs to. */
  mainRepoPath: string;
  branch: string;
  cto: { sessionId: string; incarnation: string; roleKey: string; generation: number };
  taskId: string;
  worker: { sessionId: string; incarnation: string; generation: number; externalSessionId: string };
  claimId: string;
  ownedPaths: string[];
}

export interface WorldCore {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  telemetry: Telemetry;
}

/** `makeCore` on a database file, for the witnesses that open a second, outside connection to it. */
export const fileCore = (path: string): WorldCore => {
  const db = new Db(path);
  const clock = new ManualClock();
  const audit = new AuditLog(db, clock);
  const outbox = new Outbox(db, clock, audit);
  const sessions = new SessionRegistry(db, clock, audit);
  return { db, clock, audit, sessions, bindings: new BindingRegistry(db, clock, audit, sessions, outbox), telemetry: new Telemetry(db, clock) };
};

/**
 * A raw writer on an outside connection that has registered its own `acp_worker_process_record_authorized`
 * answering 1 — the one forgery a connection-local marker cannot see — writing a pid and start time
 * into an execution. What stands between that row and a kill is the runner's ownership check.
 */
export const forgeWorkerProcessRecord = (path: string, executionId: string, pid: number, startedAt: string | null): void => {
  const raw = new Database(path);
  try {
    raw.function("acp_worker_process_record_authorized", { varargs: true }, () => 1);
    raw.prepare(`UPDATE task_executions SET worker_process_id = ?, worker_process_started_at = ? WHERE execution_id = ?`)
      .run(pid, startedAt, executionId);
  } finally {
    raw.close();
  }
};

/** A capacity gate that admits: provider capacity is PR-A's change (B1), not what these witnesses measure. */
export const admittingCapacity = {
  refreshForWorkerFanout: async () => allow(ReasonCode.OK, undefined),
  workerReserveDemand: (): DynamicReserveDemand => ({
    criticalRoleInvocations: 0,
    expectedReviews: 0,
    inFlightRuns: 0,
    burnRatePercentPerHour: 0,
  }) as DynamicReserveDemand,
};

export const seedWorkerWorld = (
  core: WorldCore,
  options: {
    ownerGeneration?: number;
    ownedPaths?: string[];
    projectId?: string;
    /** The worker session's incarnation, as a provider-provisioned session carries it (`<provider session id>#<at>`). */
    workerIncarnation?: string;
    /** Register a linked worktree (its `.git` is a file) as the run's checkout, not the main checkout. */
    linkedWorktree?: boolean;
  } = {},
): WorkerWorld => {
  const { db, clock, audit, sessions, bindings, telemetry } = core;
  const now = clock.nowIso();
  const projectId = options.projectId ?? "prj_worker_fixture";
  const identity = `github:acme/${projectId}`;
  const generation = options.ownerGeneration ?? 1;
  const ownedPaths = options.ownedPaths ?? ["src"];
  const mainRepoPath = makeRepo({
    "README.md": "# worker fixture\n",
    "src/app.js": "module.exports = () => 1;\n",
  });
  const branch = "task/worker";
  let repoPath = mainRepoPath;
  if (options.linkedWorktree) {
    repoPath = join(tempDir("acp-linked-worktree-"), "tree");
    gitSync(mainRepoPath, ["worktree", "add", "-q", "-b", branch, repoPath]);
  } else {
    gitSync(mainRepoPath, ["checkout", "-q", "-b", branch]);
  }

  const runId = newRunId();
  const repositoryId = newRepositoryId();
  const ctoSessionId = newSessionId();
  const ctoIncarnation = `${ctoSessionId}#cto`;
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [projectId, "worker fixture", now]);
  db.run(
    `INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at)
     VALUES (?, ?, ?, ?, 'primary', ?)`,
    [repositoryId, identity, repoPath, projectId, now],
  );
  db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, ?, 'claude', 'opus', 'READY', ?, ?)`,
    [ctoSessionId, ctoIncarnation, now, now],
  );
  const ctoActor = `actor:${newAssignmentId()}`;
  db.run(
    `INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'PRIMARY_CTO', ?, ?, ?)`,
    [ctoActor, ctoSessionId, ctoIncarnation, now],
  );
  db.run(
    `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, actor_id, session_id,
                              session_incarnation, binding_generation, mode, status, created_at)
     VALUES (?, ?, 'PRIMARY_CTO', ?, ?, ?, ?, ?, ?, 'PREFERRED', 'ACTIVE', ?)`,
    [newAssignmentId(), roleKey, projectId, runId, ctoActor, ctoSessionId, ctoIncarnation, generation, now],
  );
  db.run(
    `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
                       owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key, created_at)
     VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'worker fixture goal', 'sha256:contract',
             ?, ?, ?, ?, ?)`,
    [runId, projectId, ctoSessionId, generation, ctoIncarnation, roleKey, now],
  );
  db.run(
    `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch) VALUES (?, ?, 'primary', 'dev')`,
    [runId, repositoryId],
  );

  const tasks = new TaskGraph(db, clock, audit, telemetry);
  tasks.attach({
    capacity: admittingCapacity,
    workerBindings: {
      hasLiveWorkerBinding: (taskId, sessionId) => {
        const binding = bindings.active(roleKeyFor(Role.WORKER, { taskId }));
        return Boolean(
          binding && binding.role === Role.WORKER && binding.taskId === taskId && binding.sessionId === sessionId &&
            sessions.get(sessionId)?.lifecycle === SessionLifecycle.READY,
        );
      },
    },
  });
  const submitted = tasks.submit(runId, [
    { key: "T1", title: "Make app() return 2", category: "implementation", spec: { goal: "app() returns 2" } },
  ]);
  if (!submitted.allowed) throw new Error(`task submission failed: ${submitted.message}`);
  const taskId = submitted.value[0]!.taskId;

  const worker = bindWorkerSession(core, { taskId, runId, projectId }, options.workerIncarnation);

  const claims = new ClaimRegistry(db, clock, audit, bindings);
  const acquired = claims.acquire({
    runId,
    ownerSessionId: ctoSessionId,
    ownerBindingGeneration: generation,
    ownerRoleKey: roleKey,
    repositoryIdentity: identity,
    branch,
    worktreeId: repoPath,
    declaredPaths: ownedPaths,
  });
  if (!acquired.allowed) throw new Error(`claim failed: ${acquired.message}`);
  const claimId = acquired.value.find((claim) => claim.worktreeId !== null)!.claimId;

  const guard = new ManagedWriteGuard(db, realWorkspaceProbe, audit, clock);
  return {
    db, clock, audit, sessions, bindings, tasks, claims, guard,
    broker: new GuardedInvocationWriteBroker(guard),
    runId, projectId, repositoryId, identity, repoPath, mainRepoPath, branch,
    cto: { sessionId: ctoSessionId, incarnation: ctoIncarnation, roleKey, generation },
    taskId, worker, claimId, ownedPaths,
  };
};

/** A fresh READY Claude/Opus session bound as the task's WORKER, the way PR-A provisions one. */
export const bindWorkerSession = (
  core: Pick<WorldCore, "sessions" | "bindings">,
  scope: { taskId: string; runId: string; projectId: string },
  provisionedIncarnation?: string,
): WorkerWorld["worker"] => {
  const session = core.sessions.create({
    provider: "claude",
    model: "opus",
    ...(provisionedIncarnation ? { incarnation: provisionedIncarnation } : {}),
  });
  const ready = core.sessions.transition(session.sessionId, SessionLifecycle.READY, "worker fixture");
  if (!ready.allowed) throw new Error(`worker session readiness failed: ${ready.message}`);
  const bound = core.bindings.bind({
    role: Role.WORKER,
    sessionId: session.sessionId,
    taskId: scope.taskId,
    runId: scope.runId,
    projectId: scope.projectId,
  });
  if (!bound.allowed) throw new Error(`worker binding failed: ${bound.reasonCode} ${bound.message}`);
  const incarnation = core.sessions.get(session.sessionId)!.incarnation;
  return {
    sessionId: session.sessionId,
    incarnation,
    generation: bound.value.bindingGeneration,
    externalSessionId: incarnation.split("#", 1)[0]!,
  };
};

/** What the fake provider does once the broker has admitted its launch. */
export interface FakeTurnScript {
  /** Files the "provider" writes, worktree-relative. */
  writes?: Record<string, string>;
  exitCode?: number;
  /** Reported as the provider's session id; defaults to the requested external session id. */
  providerSessionId?: string | null;
  /** Overrides the start time reported through onSpawn (a mismatching one, for the restart witness). */
  reportedStartedAt?: string | null;
  /** Keep the turn open until the child is killed or the invocation is aborted. */
  hold?: boolean;
  /**
   * With `hold`: the child outlives its runner, as it does when the daemon itself dies — an abort
   * from the runner that launched it does not stop it; only a kill from outside does.
   */
  ignoreAbort?: boolean;
  /** Called inside the latched effect after the writes; the test cancels or takes over here. */
  whileLatched?: () => void | Promise<void>;
  /** Never reaches the broker and spawns nothing. */
  neverRuns?: boolean;
}

/**
 * The fake adapter the witnesses drive. It goes through the real GuardedInvocationWriteBroker → Managed
 * Write Guard, spawns a real (inert) child so onSpawn reports a real pid and its real OS start time,
 * writes its files only inside the admitted effect, and counts both launches and writes.
 */
export class FakeWorkerAdapter implements ProviderAdapter {
  readonly provider = "claude";
  readonly isProduction = true;
  readonly defaultModels = { worker: "opus" } as const;
  launches = 0;
  writes = 0;
  readonly requests: InvocationRequest[] = [];
  readonly children: ChildProcess[] = [];
  script: FakeTurnScript = { writes: { "src/app.js": "module.exports = () => 2;\n" } };

  constructor(private readonly broker: ManagedInvocationWriteBroker) {}

  async startSession(): Promise<SessionHandle> {
    throw new Error("not used");
  }
  async stopSession(): Promise<void> {}
  async probeRuntime(): Promise<"HEALTHY"> {
    return "HEALTHY";
  }
  async probeSession(): Promise<"HEALTHY"> {
    return "HEALTHY";
  }
  async probeCapacity(): Promise<CapacityReading> {
    return { provider: "claude", sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY", observedAt: new Date(0).toISOString(), buckets: [], source: "fake" };
  }

  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    this.requests.push(request);
    const script = this.script;
    const refused = (error: string): InvocationResult => ({
      ok: false, text: "", json: null, provider: "claude", model: request.model ?? "opus", durationMs: 0,
      exitCode: null, error, providerSessionId: null, isolationAttested: false,
    });
    if (script.neverRuns) return refused("the provider could not be launched");
    if (!request.managedWrite) return refused("WRITE_REQUIRES_MANAGED_RUN: no managed write");
    const authorised = await this.broker.authorize(request.managedWrite, async () => {
      this.launches += 1;
      // Its command line carries the worker session the way the provider CLI's does (`--session-id`).
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", "--", "--session-id", request.externalSessionId ?? ""],
        { detached: true, stdio: "ignore" },
      );
      this.children.push(child);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const kill = (): void => {
        try {
          process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {
          /* gone */
        }
      };
      try {
        request.onSpawn?.(child.pid!, script.reportedStartedAt === undefined ? readProcessStartToken(child.pid!) : script.reportedStartedAt);
      } catch {
        kill();
        await exited;
        return { exitCode: null as number | null, stdout: "" };
      }
      for (const [path, content] of Object.entries(script.writes ?? {})) {
        const full = join(request.managedWrite!.targetPath, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
        this.writes += 1;
      }
      if (script.whileLatched) await script.whileLatched();
      if (script.hold) {
        if (!script.ignoreAbort) {
          request.signal?.addEventListener("abort", kill, { once: true });
          if (request.signal?.aborted) kill();
        }
        await exited;
        return { exitCode: null as number | null, stdout: "" };
      }
      kill();
      await exited;
      const exitCode = script.exitCode ?? 0;
      const sessionId = script.providerSessionId === undefined ? (request.externalSessionId ?? null) : script.providerSessionId;
      return { exitCode, stdout: JSON.stringify({ session_id: sessionId, result: "changed app.js" }), sessionId };
    });
    if (!authorised.allowed) return refused(`${authorised.reasonCode}: ${authorised.message}`);
    const effect = authorised.value as { exitCode: number | null; stdout: string; sessionId?: string | null };
    return {
      ok: effect.exitCode === 0,
      text: "changed app.js",
      json: null,
      provider: "claude",
      model: request.model ?? "opus",
      durationMs: 1,
      exitCode: effect.exitCode,
      error: effect.exitCode === 0 ? null : request.signal?.aborted ? "aborted" : `exit ${String(effect.exitCode)}`,
      providerSessionId: effect.sessionId ?? null,
      stdout: effect.stdout,
      isolationAttested: false,
    };
  }

  /** Kills every child this adapter spawned; for test cleanup. */
  killAll(): void {
    for (const child of this.children) {
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}
