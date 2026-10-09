import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { main as stateAdmin } from "../../src/db/state-admin.ts";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/** The account the kernel says runs this test, which is the only approver the command admits. */
const ACCOUNT = userInfo().username;
/** A second declared owner whose name can never be the running account. */
const OTHER_OWNER = `${ACCOUNT}-is-not-this-account`;

const setup = async (live: { run?: boolean; binding?: boolean; bindingOnFinishedRun?: boolean } = {}) => {
  const harness = makeHarness();
  const { projectId } = await registerFixtureProject(harness);
  if (live.bindingOnFinishedRun) {
    const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.SIMPLE,
      contract: { goal: "finished", why: "a run-scoped binding can outlive its run", scope: [], nonGoals: [],
        acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] } });
    if (!created.allowed) throw new Error(created.message);
    const session = harness.cp.sessions.create({ provider: "claude", model: "opus" });
    expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "reviewer ready").allowed).toBe(true);
    const bound = harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: created.value.runId, sessionId: session.sessionId });
    if (!bound.allowed) throw new Error(bound.message);
    expect(harness.cp.runs.transition(created.value.runId, RunState.CANCELLED, "test: finished").allowed).toBe(true);
  }
  if (live.run) {
    const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.SIMPLE,
      contract: { goal: "in flight", why: "work the offline door must not strand", scope: [], nonGoals: [],
        acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] } });
    if (!created.allowed) throw new Error(created.message);
    expect(harness.cp.runs.transition(created.value.runId, RunState.ACTIVE, "test: in flight").allowed).toBe(true);
  }
  if (live.binding) {
    const session = harness.cp.sessions.create({ provider: "claude", model: "opus" });
    expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "cto ready").allowed).toBe(true);
    expect(harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId }).allowed)
      .toBe(true);
  }
  harness.cp.db.close();
  const databasePath = join(harness.root, "state.sqlite");
  // The deployment's owner declaration, which the command checks the approver against.
  writeFileSync(join(harness.root, "owner-identities"), `cli:${ACCOUNT}\ncli:${OTHER_OWNER}\n`, { mode: 0o600 });
  const args = ["suspend-project", "--database", databasePath, "--project-id", projectId,
    "--approved-by", ACCOUNT, "--confirm-suspend"];
  return { databasePath, projectId, args, root: harness.root };
};

const suspendedAudits = (databasePath: string, projectId: string) => {
  const db = new Database(databasePath, { readonly: true });
  try {
    return {
      suspended: (db.prepare("SELECT suspended FROM projects WHERE project_id = ?").get(projectId) as { suspended: number })
        .suspended,
      audits: (db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind = 'PROJECT_SUSPENDED'").get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
};

const snapshot = (databasePath: string) =>
  new Map(readdirSync(dirname(databasePath))
    .filter((name) => name === "state.sqlite" || /^state\.sqlite-(?:wal|shm|journal)$/.test(name))
    .map((name) => [name, readFileSync(join(dirname(databasePath), name))]));

describe("#1032: offline project suspension", () => {
  it("refuses while a live agentcpd holds the state lock", async () => {
    const { databasePath, args } = await setup();
    const lock = new SingleInstanceLock(join(dirname(databasePath), "agentcpd.lock"));
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(true);
    try {
      await expect(stateAdmin(args)).rejects.toThrow(new RegExp(`agentcpd pid ${process.pid} holds the state lock`));
    } finally {
      lock.release();
    }
  });

  it.each([
    ["approval", ["--approved-by", ACCOUNT]],
    ["confirmation", ["--confirm-suspend"]],
  ])("refuses without %s", async (_label, omitted) => {
    const { args } = await setup();
    await expect(stateAdmin(args.filter((token) => !omitted.includes(token))))
      .rejects.toThrow(/--approved-by.*--confirm-suspend/);
  });

  it("refuses a declared owner's name typed by an account that is not that owner", async () => {
    const { databasePath, projectId, args } = await setup();
    await expect(stateAdmin(args.map((token) => token === ACCOUNT ? OTHER_OWNER : token)))
      .rejects.toThrow(/not the account running this command/);
    expect(suspendedAudits(databasePath, projectId)).toEqual({ suspended: 0, audits: 0 });
  });

  it("refuses the running account when the deployment did not declare it as a cli owner", async () => {
    const { databasePath, projectId, args, root } = await setup();
    writeFileSync(join(root, "owner-identities"), `cli:${OTHER_OWNER}\n`, { mode: 0o600 });
    await expect(stateAdmin(args)).rejects.toThrow(/not a declared cli owner identity/);
    expect(suspendedAudits(databasePath, projectId)).toEqual({ suspended: 0, audits: 0 });
  });

  it("refuses every approver when the deployment declares no owner", async () => {
    const { databasePath, projectId, args, root } = await setup();
    rmSync(join(root, "owner-identities"));
    await expect(stateAdmin(args)).rejects.toThrow(/not a declared cli owner identity/);
    expect(suspendedAudits(databasePath, projectId)).toEqual({ suspended: 0, audits: 0 });
  });

  it.each([
    ["an unfinished run", { run: true }],
    ["an active binding", { binding: true }],
    ["a run-scoped binding left active after its run finished", { bindingOnFinishedRun: true }],
  ])("refuses a project with %s, which only the daemon's owner path can quiesce", async (_label, live) => {
    const { databasePath, projectId, args } = await setup(live);
    await expect(stateAdmin(args)).rejects.toThrow(/suspend it through the running daemon/);
    expect(suspendedAudits(databasePath, projectId)).toEqual({ suspended: 0, audits: 0 });
  });

  it("refuses an unknown project id without writing an audit row", async () => {
    const { databasePath, args } = await setup();
    await expect(stateAdmin(args.map((token) => token === "fixture-project" ? "unknown-project" : token)))
      .rejects.toThrow(/unknown project/);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind = 'PROJECT_SUSPENDED'").get())
        .toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it.each([SCHEMA_VERSION - 1, SCHEMA_VERSION + 1])(
    "refuses schema version %s before changing database or sidecar bytes", async (version) => {
    const { databasePath, args } = await setup();
    const raw = new Database(databasePath);
    raw.pragma(`user_version = ${version}`);
    raw.close();
    const before = snapshot(databasePath);
    await expect(stateAdmin(args)).rejects.toThrow(/schema version/);
    const after = snapshot(databasePath);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, bytes] of before) expect(after.get(name)).toEqual(bytes);
    },
  );

  it("suspends through the registry, audits the owner's approval, and leaves the schema version", async () => {
    const { databasePath, projectId, args } = await setup();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await stateAdmin(args)).toBe(0);
      expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toMatchObject({
        projectId, suspended: true, approvedBy: ACCOUNT,
      });
    } finally {
      write.mockRestore();
    }
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT suspended FROM projects WHERE project_id = ?").get(projectId))
        .toMatchObject({ suspended: 1 });
      const rows = db.prepare("SELECT evidence_json FROM audit_events WHERE kind = 'PROJECT_SUSPENDED' AND project_id = ?")
        .all(projectId) as { evidence_json: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.evidence_json)).toMatchObject({
        ownerApproved: true, approvedBy: ACCOUNT, source: "agentcpd-state",
      });
    } finally {
      db.close();
    }
  });
});

/**
 * #1070: this build's daemon holds `agentcpd.lock` as a private directory with its record in
 * `holder.json`. `agentcpd-state` reads it fail-closed: it goes on only past a holder proven gone, and
 * never removes or replaces the directory.
 */
describe("#1070: agentcpd-state against the daemon's holder directory", () => {
  const lockDirOf = (databasePath: string): string => join(dirname(databasePath), "agentcpd.lock");
  const seedHolder = (databasePath: string, record: unknown | null): string => {
    const dir = lockDirOf(databasePath);
    mkdirSync(dir, { mode: 0o700 });
    if (record !== null) {
      writeFileSync(join(dir, "holder.json"), typeof record === "string" ? record : JSON.stringify(record), { mode: 0o600 });
    }
    return dir;
  };
  const recordOf = (dir: string, pid: number, startToken: string | null = null) =>
    ({ pid, startedAt: "2026-10-09T00:00:00.000Z", path: dir, startToken });
  const deadPid = (): number => {
    const pid = Number(boundedSpawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    expect(() => process.kill(pid, 0)).toThrow();
    return pid;
  };
  const untouched = (dir: string) => {
    const before = { ino: lstatSync(dir).ino, record: existsSync(join(dir, "holder.json")) ? readFileSync(join(dir, "holder.json")) : null };
    return () => {
      expect(lstatSync(dir).isDirectory()).toBe(true);
      expect(lstatSync(dir).ino).toBe(before.ino);
      if (before.record === null) expect(existsSync(join(dir, "holder.json"))).toBe(false);
      else expect(readFileSync(join(dir, "holder.json")).equals(before.record)).toBe(true);
    };
  };
  const approveArgs = (databasePath: string) =>
    ["approve-migration", "--database", databasePath, "--approved-by", ACCOUNT, "--confirm-migration"];

  it("refuses while a live holder's directory stands, naming the holder, and leaves it as it was", async () => {
    const { databasePath, args } = await setup();
    const running = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { running.once("spawn", resolve); running.once("error", reject); });
      const dir = seedHolder(databasePath, recordOf(lockDirOf(databasePath), running.pid!));
      const check = untouched(dir);
      await expect(stateAdmin(args)).rejects.toThrow(new RegExp(`agentcpd pid ${running.pid} holds the state lock`));
      await expect(stateAdmin(approveArgs(databasePath))).rejects.toThrow(new RegExp(`agentcpd pid ${running.pid} holds the state lock`));
      check();
    } finally {
      running.kill("SIGKILL");
    }
  });

  it("goes on past a holder proven dead (ESRCH), and leaves the directory as it was", async () => {
    const { databasePath } = await setup();
    const dir = seedHolder(databasePath, recordOf(lockDirOf(databasePath), deadPid()));
    const check = untouched(dir);
    // Past the holder check, the approval's own refusal: this database needs no migration.
    await expect(stateAdmin(approveArgs(databasePath))).rejects.toThrow(/already at the build's schema version/);
    check();
  });

  it("goes on past a holder whose pid now belongs to a process with another start token", async () => {
    const { databasePath } = await setup();
    const dir = seedHolder(databasePath, recordOf(lockDirOf(databasePath), process.pid, "not-this-process-start-token"));
    const check = untouched(dir);
    await expect(stateAdmin(approveArgs(databasePath))).rejects.toThrow(/already at the build's schema version/);
    check();
  });

  it("a dead holder's directory: suspension goes on, and the daemon lock itself reclaims and then releases it", async () => {
    const { databasePath, projectId, args } = await setup();
    seedHolder(databasePath, recordOf(lockDirOf(databasePath), deadPid()));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await stateAdmin(args)).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(suspendedAudits(databasePath, projectId)).toEqual({ suspended: 1, audits: 1 });
    // The lock took the dead holder's directory under its SQLite lock and released it cleanly.
    expect(existsSync(lockDirOf(databasePath))).toBe(false);
  });

  it("refuses a holder directory with no record, and leaves it as it was", async () => {
    const { databasePath, args } = await setup();
    const dir = seedHolder(databasePath, null);
    const check = untouched(dir);
    await expect(stateAdmin(args)).rejects.toThrow(/holds no holder record/);
    await expect(stateAdmin(approveArgs(databasePath))).rejects.toThrow(/holds no holder record/);
    check();
  });

  it("refuses a holder record it cannot read, and leaves it as it was", async () => {
    const { databasePath, args } = await setup();
    const dir = seedHolder(databasePath, "{");
    const check = untouched(dir);
    await expect(stateAdmin(args)).rejects.toThrow(/holder record cannot be read/);
    check();
  });

  it("refuses a symbolic link at the lock path as insecure", async () => {
    const { databasePath, root, args } = await setup();
    const target = join(root, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, "holder.json"), JSON.stringify(recordOf(target, deadPid())), { mode: 0o600 });
    symlinkSync(target, lockDirOf(databasePath));
    await expect(stateAdmin(args)).rejects.toMatchObject({ reasonCode: "STATE_PATH_INSECURE" });
    await expect(stateAdmin(approveArgs(databasePath))).rejects.toMatchObject({ reasonCode: "STATE_PATH_INSECURE" });
    expect(lstatSync(lockDirOf(databasePath)).isSymbolicLink()).toBe(true);
  });
});
