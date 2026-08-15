import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualClock, isoPlus, type Clock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { newAssignmentId, newRepositoryId, newRunId, newSessionId } from "../../src/core/ids.ts";
import { ArtifactStore } from "../../src/db/artifacts.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { Db } from "../../src/db/database.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { BindingRegistry } from "../../src/session/binding-registry.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import type { Role } from "../../src/domain/types.ts";

export const makeDb = (): Db => new Db(":memory:");

export interface CoreHarness {
  db: Db;
  clock: ManualClock;
  audit: AuditLog;
  artifacts: ArtifactStore;
  outbox: Outbox;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  telemetry: Telemetry;
}

/**
 * `clock` exists for live acceptance captures. A capture performs real external writes, so a
 * deterministic domain clock would stamp evidence that disagrees with the timestamps the
 * remote system records — an artefact whose chronology cannot be reconstructed later.
 * Tests keep the deterministic default.
 */
export const makeCore = (options: { clock?: ManualClock | Clock } = {}): CoreHarness => {
  const db = makeDb();
  const clock = (options.clock ?? new ManualClock()) as ManualClock;
  const audit = new AuditLog(db, clock);
  const outbox = new Outbox(db, clock, audit);
  const sessions = new SessionRegistry(db, clock, audit);
  return {
    db,
    clock,
    audit,
    artifacts: new ArtifactStore(db, clock),
    outbox,
    sessions,
    bindings: new BindingRegistry(db, clock, audit, sessions, outbox),
    telemetry: new Telemetry(db, clock),
  };
};

let tempRoots: string[] = [];

export const tempDir = (prefix = "acp-test-"): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
};

export const cleanupTempDirs = (): void => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots = [];
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "ACP Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ACP Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

export const gitSync = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

/** A real git repository with a base branch, used for snapshot and verification tests. */
export const makeRepo = (
  files: Record<string, string> = { "README.md": "# fixture\n" },
  baseBranch = "dev",
): string => {
  const dir = tempDir("acp-repo-");
  execFileSync("git", ["init", "-q", "-b", baseBranch, dir], { env: GIT_ENV });
  writeFiles(dir, files);
  gitSync(dir, ["add", "-A"]);
  gitSync(dir, ["commit", "-q", "-m", "base"]);
  return dir;
};

export const writeFiles = (root: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
};

export const commitAll = (repo: string, message: string): string => {
  gitSync(repo, ["add", "-A"]);
  gitSync(repo, ["commit", "-q", "-m", message]);
  return gitSync(repo, ["rev-parse", "HEAD"]);
};

/** Insert the minimum rows needed to make a run writable, bypassing the service layer. */
export interface SeedRunOptions {
  db: Db;
  clock: ManualClock;
  repoPath: string;
  identity?: string;
  role?: Role;
  state?: string;
  /** Set false to seed a run that holds no claim, so a write-time refusal can be shown. */
  claim?: boolean;
}

export interface SeededRun {
  runId: string;
  sessionId: string;
  repositoryId: string;
  identity: string;
  generation: number;
  roleKey: string;
  projectId: string;
}


/**
 * Creates a conversational actor for a raw-SQL binding insert (#449).
 *
 * The runtime pointer is left NULL — the CHECK allows both-null — so a test that seeds an
 * assignment against a synthetic session id does not also have to seed a `sessions` row it does
 * not care about. Tests exercising the actor's live runtime set it explicitly.
 */
export const seedActor = (
  db: { run: (sql: string, params?: unknown[]) => unknown },
  kind: string,
  sessionId?: string,
  incarnation = "inc-1",
): string => {
  const actorId = `actor:${newAssignmentId()}`;
  // #493 — the actor holds the live runtime, and `task_executions_worker_binding_required` now
  // asks the actor rather than the binding. A seeded actor with no runtime therefore refuses the
  // worker's own executions, so callers that exercise that path pass the session.
  db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, ?, ?, ?, 't')`,
    [actorId, kind, sessionId ?? null, sessionId ? incarnation : null],
  );
  return actorId;
};

export const seedRun = (options: SeedRunOptions): SeededRun => {
  const { db, clock } = options;
  const now = clock.nowIso();
  const identity = options.identity ?? "github:acme/fixture";
  const projectId = "prj_fixture";
  const runId = newRunId();
  const sessionId = newSessionId();
  const repositoryId = newRepositoryId();
  const roleKey = `PRIMARY_CTO:${projectId}`;

  db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "fixture",
    now,
  ]);
  db.run(
    `INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at)
     VALUES (?, ?, ?, ?, 'primary', ?)`,
    [repositoryId, identity, options.repoPath, projectId, now],
  );
  db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, now, now],
  );
  // The actor comes first, then the binding: a binding names an actor (#449), and a run's owner
  // tuple has a composite foreign key onto the assignment it names (§30.2), so neither a run nor
  // a binding can be seeded before what it references exists.
  const actorId = `actor:${newAssignmentId()}`;
  db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, ?, ?, 'inc-1', ?)`,
    [actorId, options.role ?? "PRIMARY_CTO", sessionId, now],
  );
  db.run(
    `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, actor_id,
                              session_id, session_incarnation, binding_generation, mode, status,
                              created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [newAssignmentId(), roleKey, options.role ?? "PRIMARY_CTO", projectId, runId, actorId,
     sessionId, now],
  );
  db.run(
    `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                       contract_digest, owner_session_id, owner_binding_generation,
                       owner_session_incarnation, owner_role_key, created_at)
     VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', ?, 'fixture goal', 'sha256:contract',
             ?, 1, 'inc-1', ?, ?)`,
    [runId, projectId, options.state ?? "ACTIVE", sessionId, roleKey, now],
  );
  db.run(
    `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch)
     VALUES (?, ?, 'primary', 'dev')`,
    [runId, repositoryId],
  );
  // A run that writes holds a claim on what it writes (§23.2). Seeding one keeps the
  // fixture a realistic run rather than one the guard would have to refuse at write time.
  if (options.claim !== false) {
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, declared_path, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES (?, ?, '.', ?, ?, 1, ?, ?, 'HELD')`,
      [`clm_${runId.slice(-8)}`, identity, runId, sessionId, now, isoPlus(now, 3_600_000)],
    );
  }

  return { runId, sessionId, repositoryId, identity, generation: 1, roleKey, projectId };
};

/**
 * Moves a seeded run through the §29 authority, the way the engine does.
 *
 * A raw `UPDATE runs SET state` is refused by the database now (#66), and that is the point —
 * so a unit test with no RunEngine claims the authority itself and takes the edge as one
 * operation, rather than proving the trigger works a second time.
 */
const seededRunAuthorities = new Map<string, ReturnType<Db["claimRunStateTransitionAuthority"]>>();

export const transitionSeededRun = (db: Db, runId: string, toState: string): void => {
  // Claimed once per database: the authority is issued exactly once, which is the point of it.
  let authority = seededRunAuthorities.get(db.file);
  if (!authority) {
    authority = db.claimRunStateTransitionAuthority();
    seededRunAuthorities.set(db.file, authority);
  }
  db.applyRunStateTransition(authority, {
    runId,
    toState,
    recordTransitionEvidence: () => allow(ReasonCode.OK, undefined),
    enqueueTransitionEnvelope: () => allow(ReasonCode.OK, undefined),
    updateState: () => db.run(`UPDATE runs SET state = ? WHERE run_id = ?`, [toState, runId]),
  });
};
