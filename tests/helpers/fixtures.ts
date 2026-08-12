import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { newAssignmentId, newRepositoryId, newRunId, newSessionId } from "../../src/core/ids.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { Db } from "../../src/db/database.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import type { Role } from "../../src/domain/types.ts";

export const makeDb = (): Db => new Db(":memory:");

export interface CoreHarness {
  db: Db;
  clock: ManualClock;
  audit: AuditLog;
  outbox: Outbox;
  telemetry: Telemetry;
}

export const makeCore = (): CoreHarness => {
  const db = makeDb();
  const clock = new ManualClock();
  const audit = new AuditLog(db, clock);
  return { db, clock, audit, outbox: new Outbox(db, clock, audit), telemetry: new Telemetry(db, clock) };
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
  db.run(
    `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                       contract_digest, owner_session_id, owner_binding_generation,
                       owner_session_incarnation, owner_role_key, created_at)
     VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', ?, 'fixture goal', 'sha256:contract',
             ?, 1, 'inc-1', ?, ?)`,
    [runId, projectId, options.state ?? "ACTIVE", sessionId, roleKey, now],
  );
  db.run(
    `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, session_id,
                              session_incarnation, binding_generation, mode, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [newAssignmentId(), roleKey, options.role ?? "PRIMARY_CTO", projectId, runId, sessionId, now],
  );
  db.run(
    `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch)
     VALUES (?, ?, 'primary', 'dev')`,
    [runId, repositoryId],
  );

  return { runId, sessionId, repositoryId, identity, generation: 1, roleKey, projectId };
};
