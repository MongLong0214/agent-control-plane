import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { ArtifactStore } from "../../src/db/artifacts.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { Db } from "../../src/db/database.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { BindingRegistry } from "../../src/session/binding-registry.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { WriteOperation } from "../../src/guard/managed-write-guard.ts";
import type { ManagedInvocationWrite } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, makeCore, tempDir, type CoreHarness } from "../helpers/fixtures.ts";
import { seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #512 B2 — a task-bound write is the WORKER's, and the guard identifies it by the WORKER binding:
 * `WORKER:<taskId>` for this run and task, ACTIVE, reached through the actor's live session and
 * incarnation, at the generation the request claims. The WORKER's generation is its own counter and is
 * never compared with the run owner's. The run owner stays fenced by its whole pinned binding.
 */

afterAll(cleanupTempDirs);

interface Fixture {
  core: CoreHarness;
  world: WorkerWorld;
  executionId: string;
  launches: () => number;
  write: (overrides?: Partial<ManagedInvocationWrite>) => ReturnType<WorkerWorld["broker"]["authorize"]>;
}

/** `makeCore`, on a database file when a witness needs a second, raw connection to it. */
const coreAt = (path?: string): CoreHarness => {
  if (!path) return makeCore();
  const db = new Db(path);
  const clock = new ManualClock();
  const audit = new AuditLog(db, clock);
  const outbox = new Outbox(db, clock, audit);
  const sessions = new SessionRegistry(db, clock, audit);
  return {
    db, clock, audit, outbox, sessions,
    artifacts: new ArtifactStore(db, clock),
    bindings: new BindingRegistry(db, clock, audit, sessions, outbox),
    telemetry: new Telemetry(db, clock),
  };
};

const fixture = (ownerGeneration = 1, path?: string): Fixture => {
  const core = coreAt(path);
  const world = seedWorkerWorld(core, { ownerGeneration });
  const started = world.tasks.startExecution({
    runId: world.runId,
    taskId: world.taskId,
    ownerBindingGeneration: world.cto.generation,
    workerSessionId: world.worker.sessionId,
    provider: "claude",
    model: "opus",
    repositoryId: world.repositoryId,
    worktreeId: world.repoPath,
  });
  if (!started.allowed) throw new Error(`execution refused: ${started.reasonCode} ${started.message}`);
  let launched = 0;
  return {
    core,
    world,
    executionId: started.value.executionId,
    launches: () => launched,
    write: (overrides = {}) =>
      world.broker.authorize(
        {
          operation: WriteOperation.FILE_MUTATION,
          targetPath: world.repoPath,
          taskId: world.taskId,
          taskReceiptId: started.value.executionId,
          assignedWorktreeId: world.repoPath,
          repositoryIdentity: world.identity,
          targetBranch: world.branch,
          runId: world.runId,
          sessionId: world.worker.sessionId,
          sessionIncarnation: world.worker.incarnation,
          bindingGeneration: world.worker.generation,
          ...overrides,
        },
        async () => {
          launched += 1;
          return "launched";
        },
      ),
  };
};

const readySession = (core: CoreHarness): { sessionId: string; incarnation: string } => {
  const session = core.sessions.create({ provider: "claude", model: "opus" });
  const ready = core.sessions.transition(session.sessionId, SessionLifecycle.READY, "witness");
  if (!ready.allowed) throw new Error(ready.message);
  return { sessionId: session.sessionId, incarnation: core.sessions.get(session.sessionId)!.incarnation };
};

describe("#512 the guard takes the WORKER binding as the identity of a task-bound write", () => {
  it("W4 admits a generation-1 WORKER under a generation-17 CTO", async () => {
    const f = fixture(17);
    expect(f.world.cto.generation).toBe(17);
    expect(f.world.worker.generation).toBe(1);
    const written = await f.write();
    expect(written.reasonCode).toBe(ReasonCode.WRITE_ALLOWED);
    expect(written.allowed).toBe(true);
    expect(f.launches()).toBe(1);
  });

  it("W4 takes the task's own WORKER binding as the identity, not another binding at the same generation", async () => {
    // One worker session is the WORKER of two tasks of the run, A and B, both at generation 1: each
    // `WORKER:<taskId>` role key counts its own generations. A write for task B is B's WORKER's. The
    // first-generation-match search answered with whichever binding it met first — A's.
    // Owner and WORKER generations agree here (both 1), so only the identity search is under test.
    const f = fixture(1);
    const added = f.world.tasks.submit(f.world.runId, [{ key: "TB", title: "task B", category: "implementation" }]);
    if (!added.allowed) throw new Error(added.message);
    const taskB = added.value[0]!.taskId;
    const boundB = f.core.bindings.bind({
      role: Role.WORKER, sessionId: f.world.worker.sessionId, taskId: taskB, runId: f.world.runId, projectId: f.world.projectId,
    });
    expect(boundB.allowed && boundB.value.bindingGeneration).toBe(1);
    const startedB = f.world.tasks.startExecution({
      runId: f.world.runId, taskId: taskB, ownerBindingGeneration: f.world.cto.generation, workerSessionId: f.world.worker.sessionId,
      provider: "claude", model: "opus", repositoryId: f.world.repositoryId, worktreeId: f.world.repoPath,
    });
    if (!startedB.allowed) throw new Error(startedB.message);

    const written = await f.write({ taskId: taskB, taskReceiptId: startedB.value.executionId });
    expect(written.reasonCode).toBe(ReasonCode.WRITE_ALLOWED);
    expect(f.launches()).toBe(1);
    const consumed = f.world.audit.byKind("MANAGED_WRITE_GUARD_CONSUMED").at(-1);
    expect(consumed?.roleKey).toBe(`WORKER:${taskB}`);
  });

  describe("W5 refuses every write that is not the live WORKER's", () => {
    it("a generation the WORKER binding does not hold", async () => {
      const f = fixture(17);
      const written = await f.write({ bindingGeneration: 17 });
      expect(written.allowed).toBe(false);
      expect(f.launches()).toBe(0);
    });

    it("a stale WORKER generation after switchTo", async () => {
      const f = fixture(17);
      const replacement = readySession(f.core);
      const switched = f.core.bindings.switchTo({
        role: Role.WORKER,
        taskId: f.world.taskId,
        runId: f.world.runId,
        projectId: f.world.projectId,
        sessionId: replacement.sessionId,
        reason: "replace the worker",
        conversation: "REPLACED",
      });
      expect(switched.allowed).toBe(true);
      const stale = await f.write();
      expect(stale.allowed).toBe(false);
      const staleOnNewSession = await f.write({ sessionId: replacement.sessionId, sessionIncarnation: replacement.incarnation });
      expect(staleOnNewSession.allowed).toBe(false);
      expect(f.launches()).toBe(0);
    });

    it("a revoked WORKER binding", async () => {
      const f = fixture();
      expect(f.core.bindings.revoke(`WORKER:${f.world.taskId}`, "revoked by the CTO").allowed).toBe(true);
      const written = await f.write();
      expect(written.allowed).toBe(false);
      expect(f.launches()).toBe(0);
    });

    it("task B written with task A's binding", async () => {
      const f = fixture();
      const added = f.world.tasks.submit(f.world.runId, [{ key: "TB", title: "task B", category: "implementation" }]);
      if (!added.allowed) throw new Error(added.message);
      const written = await f.write({ taskId: added.value[0]!.taskId });
      expect(written.allowed).toBe(false);
      expect(f.launches()).toBe(0);
    });

    it("another run", async () => {
      const f = fixture();
      const other = seedWorkerWorld(f.core, { projectId: "prj_other_run" });
      const written = await f.write({ runId: other.runId });
      expect(written.allowed).toBe(false);
      expect(f.launches()).toBe(0);
    });

    it("the old session after the WORKER's actor fails over", async () => {
      const f = fixture();
      const replacement = readySession(f.core);
      const moved = f.core.bindings.switchTo({
        role: Role.WORKER,
        taskId: f.world.taskId,
        runId: f.world.runId,
        projectId: f.world.projectId,
        sessionId: replacement.sessionId,
        reason: "the worker runtime failed over",
        conversation: "SURVIVED",
      });
      expect(moved.allowed).toBe(true);
      expect(moved.allowed && moved.value.bindingGeneration).toBe(1);
      // The binding-time session still names the old runtime; only the actor's live pointer moved.
      const written = await f.write();
      expect(written.allowed).toBe(false);
      expect(written.reasonCode).toBe(ReasonCode.BINDING_REVOKED);
      expect(f.launches()).toBe(0);
    });

    it("a stale run owner binding", async () => {
      const f = fixture();
      f.core.db.run(
        `UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'superseded' WHERE role_key = ?`,
        [f.core.clock.nowIso(), f.world.cto.roleKey],
      );
      const written = await f.write();
      expect(written.allowed).toBe(false);
      expect(written.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
      expect(f.launches()).toBe(0);
    });

    it("a run owner pin a raw writer moved to another session at the same generation", async () => {
      // With foreign keys off on its connection a raw writer can repoint the pin without touching the
      // generation. The run owner is fenced by its whole binding — generation, session, incarnation.
      const path = join(tempDir("acp-owner-pin-"), "state.sqlite");
      const f = fixture(1, path);
      const raw = new Database(path);
      try {
        raw.pragma("foreign_keys = OFF");
        raw.prepare(`UPDATE runs SET owner_session_incarnation = ? WHERE run_id = ?`)
          .run(`${f.world.cto.sessionId}#forged`, f.world.runId);
      } finally {
        raw.close();
      }
      const written = await f.write();
      expect(written.allowed).toBe(false);
      expect(written.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
      expect(f.launches()).toBe(0);
    });

    it("a request that does not name the WORKER's incarnation", async () => {
      const f = fixture();
      const written = await f.write({ sessionIncarnation: `${f.world.worker.sessionId}#an-earlier-incarnation` });
      expect(written.allowed).toBe(false);
      expect(f.launches()).toBe(0);
    });
  });
});
