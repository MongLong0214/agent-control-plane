import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { isAcpError } from "../../src/core/errors.ts";
import { newAssignmentId } from "../../src/core/ids.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS, installMigrationLedger } from "../../src/db/migrations.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ArtifactStore } from "../../src/db/artifacts.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { BindingRegistry } from "../../src/session/binding-registry.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import { cleanupTempDirs, makeCore, tempDir, type CoreHarness } from "../helpers/fixtures.ts";
import { seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #512 U7 — the implementer is a separate session, and the database says so. A WORKER binding whose
 * session is its run owner's, or holds another ACTIVE role, is refused on INSERT, on a move to ACTIVE,
 * and when a WORKER actor's live pointer moves onto such a session — whatever writes it.
 */

afterAll(cleanupTempDirs);

const V41_TRIGGERS = [
  "assignments_worker_session_independent",
  "assignments_worker_session_independent_on_activate",
  "conversational_actors_worker_session_independent",
  "assignments_session_holds_no_worker",
  "assignments_session_holds_no_worker_on_activate",
  "conversational_actors_session_holds_no_worker",
  "runs_owner_session_not_its_worker",
  // #1070: the worker-process record's guards, installed by the same step.
  "task_executions_worker_process_record_authority",
  "task_executions_worker_process_record_not_inserted",
  "task_executions_worker_process_release_authority",
  "task_executions_worker_process_release_not_inserted",
  "task_executions_worker_process_write_once",
  "task_executions_runtime_managed_immutable",
  "task_executions_outstanding_process_no_delete",
];
const IN_V41 = V41_TRIGGERS.map(() => "?").join(", ");

/** The reason a write was refused with, whether it came back as a denial or was thrown; null if admitted. */
const reasonOf = (write: () => unknown): string | null => {
  try {
    const outcome = write() as { allowed?: boolean; reasonCode?: string } | undefined;
    return outcome && outcome.allowed === false ? (outcome.reasonCode ?? null) : null;
  } catch (error) {
    return isAcpError(error) ? error.reasonCode : (error as Error).message;
  }
};

const workerActorOf = (core: ReturnType<typeof makeCore>, taskId: string): string =>
  core.db.get<{ actor_id: string }>(
    `SELECT actor_id FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
    [`WORKER:${taskId}`],
  )!.actor_id;

describe("#512 a WORKER is never the CTO's session", () => {
  it("W6 refuses raw SQL that binds the run owner's session as the task's WORKER", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    core.db.run(`UPDATE assignments SET status = 'REVOKED', revoked_at = 't', revoked_reason = 'x' WHERE role_key = ?`, [
      `WORKER:${world.taskId}`,
    ]);
    const ctoActor = core.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE role_key = ?`, [world.cto.roleKey])!.actor_id;
    const insert = () =>
      core.db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, run_id, task_id, actor_id, session_id,
                                  session_incarnation, binding_generation, mode, status, created_at)
         VALUES (?, ?, 'WORKER', ?, ?, ?, ?, ?, 2, 'PREFERRED', 'ACTIVE', 't')`,
        [newAssignmentId(), `WORKER:${world.taskId}`, world.runId, world.taskId, ctoActor, world.cto.sessionId, world.cto.incarnation],
      );
    expect(reasonOf(insert)).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    // The production registry reaches the same refusal.
    expect(reasonOf(() => core.bindings.bind({ role: Role.WORKER, sessionId: world.cto.sessionId, taskId: world.taskId, runId: world.runId })))
      .toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
  });

  it("W6 refuses a WORKER on the run owner's session even after the owner's binding is revoked", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    core.db.run(`UPDATE assignments SET status = 'REVOKED', revoked_at = 't', revoked_reason = 'x' WHERE role_key IN (?, ?)`, [
      world.cto.roleKey,
      `WORKER:${world.taskId}`,
    ]);
    // The session now holds no ACTIVE binding at all; it is still the session the run is pinned to.
    expect(reasonOf(() => core.bindings.bind({ role: Role.WORKER, sessionId: world.cto.sessionId, taskId: world.taskId, runId: world.runId })))
      .toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
  });

  it("W6 refuses a WORKER on a session that holds another ACTIVE role", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const ceo = core.sessions.create({ provider: "claude", model: "opus" });
    core.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "ceo");
    expect(core.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).allowed).toBe(true);
    const added = world.tasks.submit(world.runId, [{ key: "T2", title: "second", category: "implementation" }]);
    if (!added.allowed) throw new Error(added.message);
    expect(reasonOf(() => core.bindings.bind({ role: Role.WORKER, sessionId: ceo.sessionId, taskId: added.value[0]!.taskId, runId: world.runId })))
      .toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
  });

  it("W6 refuses moving a WORKER actor's live pointer onto the run owner's session", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const move = () =>
      core.db.run(
        `UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ? WHERE actor_id = ?`,
        [world.cto.sessionId, world.cto.incarnation, workerActorOf(core, world.taskId)],
      );
    expect(reasonOf(move)).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    // A failover onto a fresh session is still a legitimate move.
    const fresh = core.sessions.create({ provider: "claude", model: "opus" });
    core.sessions.transition(fresh.sessionId, SessionLifecycle.READY, "fresh");
    const moved = core.bindings.switchTo({
      role: Role.WORKER, taskId: world.taskId, runId: world.runId, projectId: world.projectId,
      sessionId: fresh.sessionId, reason: "failover", conversation: "SURVIVED",
    });
    expect(moved.allowed).toBe(true);
  });

  it("W6 refuses a WORKER binding's move to ACTIVE onto the run owner's session", () => {
    // Revocation is already terminal, so REVOKED → ACTIVE is refused by that guard first. This takes it
    // away on a raw connection so the worker-independence guard is the only one left to answer.
    const path = join(tempDir("acp-v41-activate-"), "state.sqlite");
    new Db(path).close();
    const raw = new Database(path);
    try {
      const now = "2026-10-04T00:00:00.000Z";
      raw.exec(`
        DROP TRIGGER assignments_revocation_terminal;
        INSERT INTO projects (project_id, name, created_at) VALUES ('prj_act', 'act', '${now}');
        INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          VALUES ('ses_cto_act', 'inc-cto', 'claude', 'opus', 'READY', '${now}', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:cto_act', 'PRIMARY_CTO', 'ses_cto_act', 'inc-cto', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES ('actor:worker_act', 'WORKER', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, project_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_cto_act', 'PRIMARY_CTO:prj_act', 'PRIMARY_CTO', 'prj_act', 'actor:cto_act', 'ses_cto_act', 'inc-cto',
                  1, 'PREFERRED', 'ACTIVE', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, task_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at, revoked_at, revoked_reason)
          VALUES ('asg_worker_act', 'WORKER:tsk_act', 'WORKER', 'tsk_act', 'actor:worker_act', 'ses_cto_act', 'inc-cto',
                  1, 'PREFERRED', 'REVOKED', '${now}', '${now}', 'seeded revoked');
      `);
      expect(() => raw.prepare(`UPDATE assignments SET status = 'ACTIVE' WHERE assignment_id = 'asg_worker_act'`).run())
        .toThrowError(/WORKER_SESSION_NOT_INDEPENDENT/);
      expect(raw.prepare(`SELECT status FROM assignments WHERE assignment_id = 'asg_worker_act'`).get()).toEqual({ status: "REVOKED" });
    } finally {
      raw.close();
    }
  });

  it("W6 v40→v41 installs the triggers and the columns", () => {
    const path = join(tempDir("acp-v41-"), "state.sqlite");
    asV40Image(path);
    const db = new Db(path);
    try {
      const triggers = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${IN_V41})`, V41_TRIGGERS);
      expect(triggers.map((row) => row.name).sort()).toEqual([...V41_TRIGGERS].sort());
      const columns = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('task_executions')`).map((row) => row.name);
      expect(columns).toContain("runtime_managed");
      expect(columns).toContain("worker_process_started_at");
      expect(columns).toContain("worker_process_released_at");
      expect(db.get<{ version: number }>(`SELECT MAX(version) AS version FROM schema_migrations`)?.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("W6 v40→v41 fails closed on a seeded violation and changes nothing", () => {
    const path = join(tempDir("acp-v41-violation-"), "state.sqlite");
    asV40Image(path, (raw) => {
      const now = "2026-10-04T00:00:00.000Z";
      raw.exec(`
        INSERT INTO projects (project_id, name, created_at) VALUES ('prj_v41', 'v41', '${now}');
        INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          VALUES ('ses_cto_v41', 'inc-cto', 'claude', 'opus', 'READY', '${now}', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:cto_v41', 'PRIMARY_CTO', 'ses_cto_v41', 'inc-cto', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:worker_v41', 'WORKER', 'ses_cto_v41', 'inc-cto', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, project_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_cto_v41', 'PRIMARY_CTO:prj_v41', 'PRIMARY_CTO', 'prj_v41', 'actor:cto_v41', 'ses_cto_v41', 'inc-cto',
                  1, 'PREFERRED', 'ACTIVE', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, task_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_worker_v41', 'WORKER:tsk_v41', 'WORKER', 'tsk_v41', 'actor:worker_v41', 'ses_cto_v41', 'inc-cto',
                  1, 'PREFERRED', 'ACTIVE', '${now}');
      `);
    });
    let refusal: unknown = null;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(isAcpError(refusal)).toBe(true);
    expect(isAcpError(refusal) && String(refusal.evidence["migrationError"])).toMatch(/v41 refuses to migrate: 1 ACTIVE WORKER binding/);
    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(40);
      expect(raw.prepare(`SELECT status FROM assignments WHERE assignment_id = 'asg_worker_v41'`).get()).toEqual({ status: "ACTIVE" });
      const triggers = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${IN_V41})`).all(...V41_TRIGGERS);
      expect(triggers).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("W6 a database whose worker-independence trigger was dropped refuses to open", () => {
    for (const trigger of V41_TRIGGERS) {
      const path = join(tempDir("acp-v41-drop-"), "state.sqlite");
      new Db(path).close();
      const raw = new Database(path);
      raw.exec(`DROP TRIGGER ${trigger}`);
      raw.close();
      expect(() => new Db(path), trigger).toThrowError(/load-bearing schema invariant/);
    }
  });
});

/** `makeCore` on a database file, for the witnesses that need a second, raw connection to it. */
const fileCore = (path: string): CoreHarness => {
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

const readySession = (core: CoreHarness): { sessionId: string; incarnation: string } => {
  const session = core.sessions.create({ provider: "claude", model: "opus" });
  const ready = core.sessions.transition(session.sessionId, SessionLifecycle.READY, "witness");
  if (!ready.allowed) throw new Error(ready.message);
  return { sessionId: session.sessionId, incarnation: core.sessions.get(session.sessionId)!.incarnation };
};

/** The worker's runtime fails over: its actor's live pointer moves to a fresh session S2; the binding still names S1. */
const failWorkerOver = (core: CoreHarness, world: WorkerWorld): { sessionId: string; incarnation: string } => {
  const s2 = readySession(core);
  const moved = core.bindings.switchTo({
    role: Role.WORKER, taskId: world.taskId, runId: world.runId, projectId: world.projectId,
    sessionId: s2.sessionId, reason: "worker runtime failed over", conversation: "SURVIVED",
  });
  if (!moved.allowed) throw new Error(`worker failover refused: ${moved.reasonCode}`);
  return s2;
};

const secondProject = (core: CoreHarness, projectId = "prj_second"): string => {
  core.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [projectId, projectId, core.clock.nowIso()]);
  return projectId;
};

const ctoState = (core: CoreHarness, world: WorkerWorld) => ({
  binding: core.bindings.active(world.cto.roleKey),
  run: core.db.get<{ owner_session_id: string; owner_binding_generation: number }>(
    `SELECT owner_session_id, owner_binding_generation FROM runs WHERE run_id = ?`,
    [world.runId],
  ),
});

describe("#512 a WORKER's session takes no other role, whichever is attached first (ACP1069-R1-02)", () => {
  it("W6r bind refuses PRIMARY_CTO on a session that already is a WORKER", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const projectId = secondProject(core);
    expect(reasonOf(() => core.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: world.worker.sessionId })))
      .toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    expect(core.bindings.active(`PRIMARY_CTO:${projectId}`)).toBeNull();
  });

  it("W6r switchTo(REPLACED) refuses to hand the run's PRIMARY_CTO to its WORKER's session, and changes nothing", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const before = ctoState(core, world);
    expect(reasonOf(() => core.bindings.switchTo({
      role: Role.PRIMARY_CTO, projectId: world.projectId, sessionId: world.worker.sessionId,
      reason: "takeover onto the worker", conversation: "REPLACED", takeover: true,
    }))).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    expect(ctoState(core, world)).toEqual(before);
  });

  it("W6r switchTo(REPLACED) refuses a CTO that owns no run onto a WORKER's session (the binding alone)", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const projectId = secondProject(core);
    const cto = readySession(core);
    expect(core.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: cto.sessionId }).allowed).toBe(true);
    expect(reasonOf(() => core.bindings.switchTo({
      role: Role.PRIMARY_CTO, projectId, sessionId: world.worker.sessionId,
      reason: "replace onto the worker", conversation: "REPLACED",
    }))).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    expect(core.bindings.active(`PRIMARY_CTO:${projectId}`)?.sessionId).toBe(cto.sessionId);
  });

  it("W6r switchTo(SURVIVED) refuses to move the PRIMARY_CTO's runtime onto its WORKER's session", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    expect(reasonOf(() => core.bindings.switchTo({
      role: Role.PRIMARY_CTO, projectId: world.projectId, sessionId: world.worker.sessionId,
      reason: "failover onto the worker", conversation: "SURVIVED",
    }))).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    expect(core.bindings.active(world.cto.roleKey)?.sessionId).toBe(world.cto.sessionId);
  });

  it("W6r after the WORKER fails over, its live session takes no other role (live pointer clause)", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const s2 = failWorkerOver(core, world);
    const projectId = secondProject(core);
    expect(reasonOf(() => core.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: s2.sessionId })))
      .toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    expect(reasonOf(() => core.bindings.switchTo({
      role: Role.PRIMARY_CTO, projectId: world.projectId, sessionId: s2.sessionId,
      reason: "failover onto the worker's live session", conversation: "SURVIVED",
    }))).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
  });

  it("W6r after the WORKER fails over, its binding-time session takes no other role either", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    failWorkerOver(core, world);
    const projectId = secondProject(core);
    expect(reasonOf(() => core.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: world.worker.sessionId })))
      .toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    expect(reasonOf(() => core.bindings.switchTo({
      role: Role.PRIMARY_CTO, projectId: world.projectId, sessionId: world.worker.sessionId,
      reason: "failover onto the worker's binding-time session", conversation: "SURVIVED",
    }))).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
  });

  it("W6r refuses a non-WORKER binding minted on the WORKER's own actor (actor clause)", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const actorId = workerActorOf(core, world.taskId);
    // The worker's actor has no live runtime at the moment; only the shared actor ties the two roles.
    core.db.run(`UPDATE conversational_actors SET current_session_id = NULL, current_session_incarnation = NULL WHERE actor_id = ?`, [actorId]);
    const ceo = readySession(core);
    const insert = () => core.db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
                                binding_generation, mode, status, created_at)
       VALUES (?, 'CEO', 'CEO', ?, ?, ?, 1, 'PREFERRED', 'ACTIVE', 't')`,
      [newAssignmentId(), actorId, ceo.sessionId, ceo.incarnation],
    );
    expect(reasonOf(insert)).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
  });

  it("W6r refuses a non-WORKER binding's move to ACTIVE on a WORKER's session", () => {
    const path = join(tempDir("acp-v41-reverse-activate-"), "state.sqlite");
    new Db(path).close();
    const raw = new Database(path);
    try {
      const now = "2026-10-04T00:00:00.000Z";
      raw.exec(`
        DROP TRIGGER assignments_revocation_terminal;
        INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          VALUES ('ses_worker_r', 'inc-w', 'claude', 'opus', 'READY', '${now}', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:worker_r', 'WORKER', 'ses_worker_r', 'inc-w', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES ('actor:ceo_r', 'CEO', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, task_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_worker_r', 'WORKER:tsk_r', 'WORKER', 'tsk_r', 'actor:worker_r', 'ses_worker_r', 'inc-w',
                  1, 'PREFERRED', 'ACTIVE', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at, revoked_at, revoked_reason)
          VALUES ('asg_ceo_r', 'CEO', 'CEO', 'actor:ceo_r', 'ses_worker_r', 'inc-w',
                  1, 'PREFERRED', 'REVOKED', '${now}', '${now}', 'seeded revoked');
      `);
      expect(() => raw.prepare(`UPDATE assignments SET status = 'ACTIVE' WHERE assignment_id = 'asg_ceo_r'`).run())
        .toThrowError(/WORKER_SESSION_NOT_INDEPENDENT/);
      expect(raw.prepare(`SELECT status FROM assignments WHERE assignment_id = 'asg_ceo_r'`).get()).toEqual({ status: "REVOKED" });
    } finally {
      raw.close();
    }
  });

  it("W6r refuses re-pinning the run's owner onto its WORKER's binding-time session", () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    failWorkerOver(core, world);
    // A tuple the composite foreign key accepts: the WORKER binding row itself.
    const repin = () => core.db.run(
      `UPDATE runs SET owner_role_key = ?, owner_binding_generation = ?, owner_session_id = ?, owner_session_incarnation = ?
        WHERE run_id = ?`,
      [`WORKER:${world.taskId}`, world.worker.generation, world.worker.sessionId, world.worker.incarnation, world.runId],
    );
    expect(reasonOf(repin)).toBe(ReasonCode.WORKER_SESSION_NOT_INDEPENDENT);
    expect(ctoState(core, world).run?.owner_session_id).toBe(world.cto.sessionId);
  });

  it("W6r refuses re-pinning the run's owner onto its WORKER's live session", () => {
    const path = join(tempDir("acp-v41-repin-"), "state.sqlite");
    const core = fileCore(path);
    const world = seedWorkerWorld(core);
    const s2 = failWorkerOver(core, world);
    const raw = new Database(path);
    try {
      raw.pragma("foreign_keys = OFF");
      expect(() => raw.prepare(`UPDATE runs SET owner_session_id = ? WHERE run_id = ?`).run(s2.sessionId, world.runId))
        .toThrowError(/WORKER_SESSION_NOT_INDEPENDENT/);
      expect(raw.prepare(`SELECT owner_session_id FROM runs WHERE run_id = ?`).get(world.runId))
        .toEqual({ owner_session_id: world.cto.sessionId });
    } finally {
      raw.close();
      core.db.close();
    }
  });

  it("W6r v40→v41 fails closed on reverse-direction violations already in the database", () => {
    const now = "2026-10-04T00:00:00.000Z";
    const images: Record<string, string> = {
      // A run pinned to the session of its own WORKER; the owner's binding is revoked, so only the pin ties them.
      "run owner pinned to its worker": `
        INSERT INTO projects (project_id, name, created_at) VALUES ('prj_r1', 'r1', '${now}');
        INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          VALUES ('ses_r1', 'inc-r1', 'claude', 'opus', 'READY', '${now}', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:cto_r1', 'PRIMARY_CTO', 'ses_r1', 'inc-r1', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:w_r1', 'WORKER', 'ses_r1', 'inc-r1', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, project_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at, revoked_at, revoked_reason)
          VALUES ('asg_cto_r1', 'PRIMARY_CTO:prj_r1', 'PRIMARY_CTO', 'prj_r1', 'actor:cto_r1', 'ses_r1', 'inc-r1',
                  1, 'PREFERRED', 'REVOKED', '${now}', '${now}', 'revoked');
        INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
                          owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key, created_at)
          VALUES ('run_r1', 'prj_r1', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'g', 'sha256:c',
                  'ses_r1', 1, 'inc-r1', 'PRIMARY_CTO:prj_r1', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, run_id, task_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_w_r1', 'WORKER:tsk_r1', 'WORKER', 'run_r1', 'tsk_r1', 'actor:w_r1', 'ses_r1', 'inc-r1',
                  1, 'PREFERRED', 'ACTIVE', '${now}');`,
      // A CTO whose live runtime failed over onto the WORKER's session; its binding-time session differs.
      "a CTO's live runtime on the worker's session": `
        INSERT INTO projects (project_id, name, created_at) VALUES ('prj_r2', 'r2', '${now}');
        INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          VALUES ('ses_r2_old', 'inc-old', 'claude', 'opus', 'READY', '${now}', '${now}');
        INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          VALUES ('ses_r2_w', 'inc-w', 'claude', 'opus', 'READY', '${now}', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:cto_r2', 'PRIMARY_CTO', 'ses_r2_w', 'inc-w', '${now}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:w_r2', 'WORKER', 'ses_r2_w', 'inc-w', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, task_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_w_r2', 'WORKER:tsk_r2', 'WORKER', 'tsk_r2', 'actor:w_r2', 'ses_r2_w', 'inc-w',
                  1, 'PREFERRED', 'ACTIVE', '${now}');
        INSERT INTO assignments (assignment_id, role_key, role, project_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_cto_r2', 'PRIMARY_CTO:prj_r2', 'PRIMARY_CTO', 'prj_r2', 'actor:cto_r2', 'ses_r2_old', 'inc-old',
                  1, 'PREFERRED', 'ACTIVE', '${now}');`,
    };
    for (const [shape, seed] of Object.entries(images)) {
      const path = join(tempDir("acp-v41-reverse-violation-"), "state.sqlite");
      asV40Image(path, (raw) => raw.exec(seed));
      let refusal: unknown = null;
      try {
        new Db(path).close();
      } catch (error) {
        refusal = error;
      }
      expect(isAcpError(refusal), shape).toBe(true);
      expect(isAcpError(refusal) && String(refusal.evidence["migrationError"]), shape)
        .toMatch(/v41 refuses to migrate: 1 ACTIVE WORKER binding/);
      const raw = new Database(path, { readonly: true, fileMustExist: true });
      try {
        expect(raw.pragma("user_version", { simple: true }), shape).toBe(40);
      } finally {
        raw.close();
      }
    }
  });
});

/** A v40 database: today's schema with v41's columns and triggers taken off and the ledger at 40. */
const asV40Image = (path: string, seed?: (raw: Database.Database) => void): void => {
  new Db(path).close();
  const raw = new Database(path);
  try {
    for (const trigger of V41_TRIGGERS) raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    for (const column of ["runtime_managed", "worker_process_started_at", "worker_process_released_at"]) {
      raw.exec(`ALTER TABLE task_executions DROP COLUMN ${column}`);
    }
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
    raw.exec("DELETE FROM schema_migrations");
    const v40 = MIGRATIONS.find((migration) => migration.toVersion === 40);
    if (!v40) throw new Error("v40 migration is absent from the ordered registry");
    raw.prepare(
      "INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(40, v40.id, v40.checksum(), "2026-10-04T00:00:00.000Z");
    installMigrationLedger(raw);
    seed?.(raw);
    raw.pragma("user_version = 40");
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  approveMigration(path, "worker-session independence v41 fixture");
};
