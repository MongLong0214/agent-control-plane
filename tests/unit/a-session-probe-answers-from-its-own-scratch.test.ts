import type * as ChildProcessModule from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { CapacityReading, SessionHandle } from "../../src/runtime/provider.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * A WORKER session's workdir is the managed runtime root, `~/.agent-control-plane/runtime`, and the
 * runtime profile denies reads of the whole `~/.agent-control-plane` tree. A session probe spawned
 * there ran a CLI that could not read its own working directory: it exited 1 in milliseconds and every
 * worker provisioning ended "provider worker session probe failed".
 *
 * HOME points at a private directory before anything is imported, so the scratch root, the profile's
 * denies and the harness's state root all follow it and the live daemon's state is never touched.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-session-probe-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

/** Every sandboxed spawn the adapter makes: its pid, the cwd it was given, and what it wrote to stderr. */
interface SandboxedSpawn {
  pid: number | undefined;
  args: string[];
  cwd: string | undefined;
  stderr: string;
}
const sandboxed = vi.hoisted((): SandboxedSpawn[] => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  const realSpawn = actual.spawn as unknown as (...params: unknown[]) => ChildProcessModule.ChildProcess;
  const spawn = (...params: unknown[]): ChildProcessModule.ChildProcess => {
    const child = realSpawn(...params);
    if (params[0] === "/usr/bin/sandbox-exec") {
      const options = params[2] as { cwd?: unknown } | undefined;
      const record: SandboxedSpawn = {
        pid: child.pid,
        args: [...(params[1] as string[])],
        cwd: typeof options?.cwd === "string" ? options.cwd : undefined,
        stderr: "",
      };
      child.stderr?.on("data", (chunk: Buffer) => (record.stderr += chunk.toString("utf8")));
      sandboxed.push(record);
    }
    return child;
  };
  return { ...actual, spawn };
});

afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const STATE_ROOT = join(isolatedHome, ".agent-control-plane");

/**
 * A `claude` stand-in that fails, as the real CLI did, when it cannot read the directory it runs in.
 *
 * Where it can, it checks the boundary did not move to let it: the session workdir and a state file
 * under the read-denied state root must still refuse a read. It then answers `-p --output-format json`
 * as the session it was told to be. Limitation: this is a stub, not the real CLI; it shows the
 * directory the probe runs in and the profile it runs under, not that the provider authenticates.
 */
const cwdSensitiveClaude = (dir: string, stillDenied: readonly string[]): string => {
  const binary = join(dir, "claude-cwd-sensitive.cjs");
  writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
const fail = (why) => { process.stderr.write("claude-stub: " + why + "\\n"); process.exit(1); };
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") { process.stdout.write("9.9.9 (Claude Code)\\n"); process.exit(0); }
let cwd;
try {
  cwd = process.cwd();
  fs.readdirSync(cwd);
} catch (error) {
  fail("cannot read its working directory: " + (error && error.code));
}
for (const path of ${JSON.stringify(stillDenied)}) {
  let refused = false;
  try {
    if (fs.statSync(path).isDirectory()) fs.readdirSync(path); else fs.readFileSync(path);
  } catch (error) {
    refused = Boolean(error && (error.code === "EPERM" || error.code === "EACCES"));
  }
  if (!refused) fail("read a path the profile must still deny: " + path);
}
const sessionId = argv[argv.indexOf("--session-id") + 1];
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, result: "READY", cwd, stdin }));
});
`);
  chmodSync(binary, 0o700);
  return binary;
};

/** A `claude` stand-in that refuses every probe the way the live run did: exit 1, at once. */
const refusingClaude = (dir: string): string => {
  const binary = join(dir, "claude-refusing.cjs");
  writeFileSync(binary, `#!${process.execPath}
process.stderr.write("An unknown error occurred (Unexpected)\\n");
process.exit(1);
`);
  chmodSync(binary, 0o700);
  return binary;
};

/** The managed runtime root and a daemon state file, both under the read-denied state root. */
const deniedStateRoot = (): { runtimeRoot: string; stateFile: string } => {
  const runtimeRoot = join(STATE_ROOT, "runtime");
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const stateFile = join(STATE_ROOT, "state.fixture");
  writeFileSync(stateFile, "synthetic-only", { mode: 0o600 });
  return { runtimeRoot, stateFile };
};

const spawnedSince = (mark: number): SandboxedSpawn[] => sandboxed.slice(mark);
const stderrSince = (mark: number): string => spawnedSince(mark).map((spawn) => spawn.stderr).join("\n");

/** The probe ran in one of this invocation's own scratch directories, which is gone once it answered. */
const expectRanInRemovedScratch = (spawn: SandboxedSpawn): void => {
  const scratchRoot = realpathSync(ACP_SCRATCH_ROOT);
  expect(spawn.cwd).toBeDefined();
  expect(spawn.cwd!.startsWith(`${scratchRoot}/`)).toBe(true);
  expect(basename(spawn.cwd!).startsWith("acp-runtime-")).toBe(true);
  expect(existsSync(spawn.cwd!)).toBe(false);
};

describe("a Claude session probe runs in its invocation's private scratch (worker probe cwd)", () => {
  it("answers HEALTHY for a session whose workdir is under the read-denied state root, without reopening it", async (ctx) => {
    requireSeatbelt(ctx);
    expect(ACP_SCRATCH_ROOT.startsWith(`${isolatedHome}/`)).toBe(true);
    const { runtimeRoot, stateFile } = deniedStateRoot();
    const stubs = tempDir("acp-session-probe-stub-");
    const adapter = new ClaudeCliAdapter({
      clock: { nowIso: () => "2026-08-12T00:00:00.000Z" } as never,
      capacityFile: join(STATE_ROOT, "capacity.fixture"),
      binary: cwdSensitiveClaude(stubs, [realpathSync(runtimeRoot), realpathSync(stateFile)]),
    });
    const parentCwd = process.cwd();
    const handle: SessionHandle = {
      externalSessionId: randomUUID(),
      provider: "claude",
      model: "opus",
      effort: null,
      pid: null,
      workdir: runtimeRoot,
    };

    const mark = sandboxed.length;
    expect(await adapter.probeSession(handle), stderrSince(mark)).toBe("HEALTHY");
    const { workdir: _omitted, ...withoutWorkdir } = handle;
    expect(await adapter.probeSession({ ...withoutWorkdir, externalSessionId: randomUUID() }), stderrSince(mark)).toBe("HEALTHY");

    const probes = spawnedSince(mark);
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expectRanInRemovedScratch(probe);
      expect(probe.cwd).not.toBe(realpathSync(runtimeRoot));
      // The probe asks about the handle's own conversation, exactly as before.
      expect(probe.args).toContain("--session-id");
    }
    expect(probes[0]!.args[probes[0]!.args.indexOf("--session-id") + 1]).toBe(handle.externalSessionId);
    expect(probes[0]!.cwd).not.toBe(probes[1]!.cwd);
    expect(process.cwd()).toBe(parentCwd);
  });

  it("stays fail-closed: a CLI that refuses or cannot be executed is UNAVAILABLE", async (ctx) => {
    requireSeatbelt(ctx);
    const { runtimeRoot } = deniedStateRoot();
    const stubs = tempDir("acp-session-probe-stub-");
    const handle: SessionHandle = {
      externalSessionId: randomUUID(),
      provider: "claude",
      model: "opus",
      effort: null,
      pid: null,
      workdir: runtimeRoot,
    };
    const options = {
      clock: { nowIso: () => "2026-08-12T00:00:00.000Z" } as never,
      capacityFile: join(STATE_ROOT, "capacity.fixture"),
    };
    expect(await new ClaudeCliAdapter({ ...options, binary: refusingClaude(stubs) }).probeSession(handle)).toBe("UNAVAILABLE");
    expect(await new ClaudeCliAdapter({ ...options, binary: join(stubs, "absent-claude") }).probeSession(handle)).toBe("UNAVAILABLE");
    expect(await new ClaudeCliAdapter({ ...options, binary: "/usr/bin/false" }).probeSession(handle)).toBe("UNAVAILABLE");
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* Worker provisioning through the real adapter, the real seatbelt and a harness under the state root */
/* ------------------------------------------------------------------------------------------------ */

const CONTRACT: TaskContract = {
  goal: "staff a worker",
  why: "a run's task needs an implementer that is not its CTO",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["the task runs on its own WORKER session"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** The real Claude adapter; only its capacity reading is supplied, since `/usage` is not under test. */
class ClaudeWithFixedCapacity extends ClaudeCliAdapter {
  reading: CapacityReading | null = null;

  override async probeCapacity(): Promise<CapacityReading> {
    if (!this.reading) throw new Error("no capacity reading was set");
    return this.reading;
  }
}

const claudeReading = (harness: Harness, remainingPercent: number, minutesAgo: number): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: new Date(harness.clock.now().getTime() - minutesAgo * 60_000).toISOString(),
  source: "session-probe-fixture",
  buckets: [{
    id: "five_hour",
    remainingPercent,
    resetAt: new Date(harness.clock.now().getTime() + 2 * 60 * 60 * 1000).toISOString(),
    capabilities: ["cto", "ceo", "blind-review", "worker"],
  }],
});

/**
 * A dispatched run with one READY task, in a deployment whose state root — and so whose managed
 * runtime root, `<root>/runtime` — lies under the read-denied `HOME/.agent-control-plane`, as the
 * shipped daemon's does. Each world gets its own root there, so no two share a database.
 */
const provisioningWorld = async (binary: (root: string, stubs: string) => string) => {
  mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(STATE_ROOT, "deployment-"));
  const harness = makeHarness({ root });
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const ownerSessionId = run.ownerSessionId!;
  const owner = harness.cp.db.get<{ binding_generation: number }>(
    `SELECT binding_generation FROM assignments WHERE session_id = ? AND status = 'ACTIVE'`,
    [ownerSessionId],
  );
  if (!owner) throw new Error("the run owner holds no active binding");

  const stubs = tempDir("acp-session-probe-stub-");
  const claude = new ClaudeWithFixedCapacity({
    clock: harness.clock,
    capacityFile: join(root, "capacity", "claude.json"),
    binary: binary(root, stubs),
  });
  harness.cp.providers.registerForRole(claude, Role.WORKER);
  // One earlier reading, so the admission probe measures the window's burn.
  claude.reading = claudeReading(harness, 81, 3);
  await harness.cp.capacity.refreshForRole("claude", Role.WORKER);
  claude.reading = claudeReading(harness, 80, 0);

  const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "implement", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const taskId = submitted.value[0]!.taskId;
  const fence = () => allow(ReasonCode.OK, { sessionId: ownerSessionId, bindingGeneration: owner.binding_generation });
  const provision = () => harness.cp.workers.provision({
    runId: run.runId,
    taskId,
    provider: "claude",
    ownerBindingGeneration: owner.binding_generation,
    fence,
  });
  return {
    harness,
    runtimeRoot: join(root, "runtime"),
    runId: run.runId,
    taskId,
    ownerSessionId,
    provision,
    close: () => harness.cp.db.close(),
  };
};

const claudeSessions = (harness: Harness) =>
  harness.cp.db.all<{ session_id: string; lifecycle: string; workdir: string | null }>(
    `SELECT session_id, lifecycle, workdir FROM sessions WHERE provider = 'claude' ORDER BY created_at`,
  );

/** Every row in every table other than the session's own record and its audit trail that names it. */
const rowsNaming = (harness: Harness, sessionId: string): Record<string, number> => {
  const found: Record<string, number> = {};
  const tables = harness.cp.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
  for (const { name } of tables) {
    if (name === "sessions" || name === "audit_events") continue;
    const columns = harness.cp.db.all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, [name])
      .map((column) => column.name)
      .filter((column) => /session_id$/.test(column));
    for (const column of columns) {
      const row = harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${column}" = ?`, [sessionId]);
      if (row && row.n > 0) found[`${name}.${column}`] = row.n;
    }
  }
  return found;
};

/** Whether a pid still names a process; `kill(pid, 0)` signals nothing. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Live processes whose command line names `marker`, read from `ps` rather than from our own records. */
const processesNaming = (marker: string): string[] =>
  execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 })
    .split("\n")
    .filter((line) => line.includes(marker));

describe("worker provisioning probes from scratch, and a refused probe leaves nothing behind", () => {
  it("provisions a READY, bound WORKER whose workdir stays the read-denied managed runtime root", async (ctx) => {
    requireSeatbelt(ctx);
    const world = await provisioningWorld((root, stubs) => {
      const runtimeRoot = join(root, "runtime");
      mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
      return cwdSensitiveClaude(stubs, [realpathSync(runtimeRoot), realpathSync(join(root, "state.sqlite"))]);
    });
    const { runtimeRoot } = world;
    try {
      const mark = sandboxed.length;
      const provisioned = await world.provision();
      if (!provisioned.allowed) {
        throw new Error(`${provisioned.reasonCode}: ${provisioned.message}\n${stderrSince(mark)}`);
      }

      const sessions = claudeSessions(world.harness);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.session_id).toBe(provisioned.value.workerSessionId);
      expect(sessions[0]!.lifecycle).toBe(SessionLifecycle.READY);
      // The session's own workdir is unchanged; only the probe moved. A WORKER turn still runs in its
      // claimed worktree, and nothing here shows that it can.
      expect(sessions[0]!.workdir).toBe(runtimeRoot);
      const bound = world.harness.cp.db.all<{ status: string; session_id: string }>(
        `SELECT status, session_id FROM assignments WHERE role_key = ?`,
        [roleKeyFor(Role.WORKER, { taskId: world.taskId })],
      );
      expect(bound).toEqual([{ status: "ACTIVE", session_id: provisioned.value.workerSessionId }]);

      const probes = spawnedSince(mark);
      expect(probes).toHaveLength(1);
      expectRanInRemovedScratch(probes[0]!);
    } finally {
      world.close();
    }
  });

  it("stops the session, binds nothing and leaves no process when the probe is refused", async (ctx) => {
    requireSeatbelt(ctx);
    let stub = "";
    const world = await provisioningWorld((_root, stubs) => (stub = refusingClaude(stubs)));
    try {
      const mark = sandboxed.length;
      const refused = await world.provision();
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);

      // The row: created, then STOPPED for exactly this reason, never READY.
      const sessions = claudeSessions(world.harness);
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0]!.session_id;
      expect(sessions[0]!.lifecycle).toBe(SessionLifecycle.STOPPED);
      const lifecycle = world.harness.cp.audit.byKind("SESSION_LIFECYCLE")
        .filter((row) => row.sessionId === sessionId)
        .map((row) => row.evidence);
      expect(lifecycle).toEqual([
        expect.objectContaining({ to: SessionLifecycle.STOPPED, reason: "provider worker session probe failed" }),
      ]);

      // The claim: no WORKER binding for the task, and no other row anywhere names the session.
      expect(world.harness.cp.db.all(
        `SELECT * FROM assignments WHERE role_key = ?`,
        [roleKeyFor(Role.WORKER, { taskId: world.taskId })],
      )).toEqual([]);
      expect(rowsNaming(world.harness, sessionId)).toEqual({});

      // The process: the probe was spawned, has exited, and nothing running names the stub.
      const probes = spawnedSince(mark);
      expect(probes).toHaveLength(1);
      expect(probes[0]!.pid).toBeTypeOf("number");
      expect(alive(probes[0]!.pid!)).toBe(false);
      expect(processesNaming(stub)).toEqual([]);
      expectRanInRemovedScratch(probes[0]!);
      expect(readdirSync(ACP_SCRATCH_ROOT)).toEqual([]);
    } finally {
      world.close();
    }
  });
});
