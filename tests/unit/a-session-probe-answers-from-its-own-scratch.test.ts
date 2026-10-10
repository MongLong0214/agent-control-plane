import type * as ChildProcessModule from "node:child_process";
import type * as ProcessArgvModule from "../../src/core/process-argv.ts";
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ClaudeCliAdapter, __testing, type ProcessGroupReap } from "../../src/runtime/cli-adapters.ts";
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

/**
 * How the adapter's start-token reads answer: as the kernel does ("native"), never ("null"), or as the
 * kernel did at spawn and differently afterwards ("mismatch-after-spawn", once `tokenRead.spawned`).
 */
const tokenRead = vi.hoisted(() => ({ mode: "native" as "native" | "null" | "mismatch-after-spawn", spawned: false }));
vi.mock("../../src/core/process-argv.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessArgvModule>();
  return {
    ...actual,
    readProcessStartToken: (pid: number): string | null => {
      if (tokenRead.mode === "null") return null;
      const token = actual.readProcessStartToken(pid);
      if (tokenRead.mode === "mismatch-after-spawn" && tokenRead.spawned && token !== null) return `${token}0`;
      return token;
    },
  };
});

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

/* ------------------------------------------------------------------------------------------------ */
/* #1077 N1-01 — nothing a probe starts outlives it, and nothing that is not the probe's is touched  */
/* ------------------------------------------------------------------------------------------------ */

type DescendantMode = "refuse" | "answer" | "hang";

/**
 * A `claude` stand-in that first starts a real descendant in its own process group — stdio ignored,
 * so nothing ties it to the probe's pipes — and reports its pid on stderr. It then refuses (exit 1),
 * answers as the session (exit 0) or hangs until it is killed. The descendant carries `marker` in its
 * argv so `ps` can find it independently of anything the adapter records.
 */
const claudeWithDescendant = (dir: string, mode: DescendantMode, marker: string): string => {
  const binary = join(dir, `claude-descendant-${mode}.cjs`);
  writeFileSync(binary, `#!${process.execPath}
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(marker)}], { stdio: "ignore" });
child.unref();
const argv = process.argv.slice(2);
process.stderr.write("cli-pid=" + process.pid + " descendant-pid=" + child.pid + "\\n", () => {
  if (${JSON.stringify(mode)} === "refuse") process.exit(1);
  if (${JSON.stringify(mode)} === "hang") { setInterval(() => {}, 1000); return; }
  const sessionId = argv[argv.indexOf("--session-id") + 1];
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, result: "READY" }), () => process.exit(0));
  });
});
`);
  chmodSync(binary, 0o700);
  return binary;
};

const descendantPids = (spawned: SandboxedSpawn): number[] =>
  [...spawned.stderr.matchAll(/descendant-pid=(\d+)/g)].map((match) => Number(match[1]));
/** The CLI stand-in's own pid: the holder's child, not the group's leader. */
const cliPids = (spawned: SandboxedSpawn): number[] =>
  [...spawned.stderr.matchAll(/cli-pid=(\d+)/g)].map((match) => Number(match[1]));

/** Members of a process group that are not zombies, read from `ps`. */
const liveMembersOf = (pgid: number): string[] =>
  execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat=,command="], { encoding: "utf8", timeout: 10_000 })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const [, group, stat] = line.split(/\s+/);
      return Number(group) === pgid && stat !== undefined && !stat.startsWith("Z");
    });

/**
 * The record cannot contradict itself: `signalled` is exactly "some signal was attempted", a cleanup
 * counted as done had ownership and began with a delivered signal, and a lost holder signalled nothing.
 */
const expectConsistentReap = (reap: ProcessGroupReap | undefined): void => {
  expect(reap).toBeDefined();
  expect(reap!.signalled).toBe(reap!.signals.length > 0);
  expect(reap!.delivered).toBe(reap!.signals.filter((result) => result === "sent").length);
  if (reap!.reaped) {
    expect(reap!.ownership).toBe("HELD");
    expect(reap!.delivered).toBeGreaterThan(0);
    expect(reap!.detail).toBeNull();
  } else {
    expect(reap!.detail).toEqual(expect.stringContaining(`process group ${reap!.pgid}`));
  }
  if (reap!.ownership !== "HELD") expect(reap!.reaped).toBe(false);
  if (reap!.ownership === "HOLDER_LOST") expect(reap!.signals).toEqual([]);
};

/** Kills only processes carrying this test's own marker: a RED run must not leave its leak behind. */
const killMarked = (marker: string): void => {
  for (const line of processesNaming(marker)) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
};

/** A process of the test's own, outside any probe: it must still be running after every reap. */
const startBystander = (marker: string, detached: boolean): ChildProcessModule.ChildProcess => {
  const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore", detached });
  child.unref();
  return child;
};

const waitFor = async (condition: () => boolean, boundMs: number): Promise<boolean> => {
  const deadline = Date.now() + boundMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

describe("a probe ends its own process group on every completion, and only its own (#1077 N1-01)", () => {
  it("a refused provisioning leaves no process: parent and same-group descendant gone, session STOPPED, nothing bound", async (ctx) => {
    requireSeatbelt(ctx);
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const bystanderMarker = `acp-probe-bystander-${randomUUID()}`;
    const bystander = startBystander(bystanderMarker, false);
    const world = await provisioningWorld((_root, stubs) => claudeWithDescendant(stubs, "refuse", marker));
    try {
      const mark = sandboxed.length;
      const refused = await world.provision();
      const probes = spawnedSince(mark);
      const sessions = claudeSessions(world.harness);
      const sessionId = sessions[0]?.session_id ?? "";
      const parent = probes[0]?.pid ?? -1;
      const descendants = probes[0] ? descendantPids(probes[0]) : [];
      const observed = {
        reasonCode: refused.reasonCode,
        sessions,
        lifecycle: world.harness.cp.audit.byKind("SESSION_LIFECYCLE").filter((row) => row.sessionId === sessionId).map((row) => row.evidence),
        assignments: world.harness.cp.db.all(`SELECT status, session_id FROM assignments WHERE role_key = ?`, [roleKeyFor(Role.WORKER, { taskId: world.taskId })]),
        rowsNamingSession: rowsNaming(world.harness, sessionId),
        parent: { pid: parent, alive: alive(parent) },
        descendants: descendants.map((pid) => ({ pid, alive: alive(pid) })),
        liveMembersOfProbeGroup: liveMembersOf(parent),
        processesNamingMarker: processesNaming(marker),
        bystanderAlive: bystander.pid !== undefined && alive(bystander.pid),
        scratchRoot: readdirSync(ACP_SCRATCH_ROOT),
      };
      console.error(`WITNESS refused-provision-descendant ${JSON.stringify(observed)}`);

      expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
      expect(probes).toHaveLength(1);
      expect(descendants).toHaveLength(1);
      // The process: the probe and the descendant it started are both gone, by pid and by group.
      expect(observed.parent.alive).toBe(false);
      expect(observed.descendants).toEqual([{ pid: descendants[0], alive: false }]);
      expect(observed.liveMembersOfProbeGroup).toEqual([]);
      expect(observed.processesNamingMarker).toEqual([]);
      // Nothing that is not the probe's was touched.
      expect(observed.bystanderAlive).toBe(true);
      // The session, the binding and every other row, and the scratch.
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(observed.lifecycle).toEqual([
        expect.objectContaining({ to: SessionLifecycle.STOPPED, reason: "provider worker session probe failed" }),
      ]);
      expect(observed.assignments).toEqual([]);
      expect(observed.rowsNamingSession).toEqual({});
      expect(observed.scratchRoot).toEqual([]);
    } finally {
      world.close();
      killMarked(marker);
      killMarked(bystanderMarker);
    }
  });

  it("a probe that answers HEALTHY leaves no descendant either", async (ctx) => {
    requireSeatbelt(ctx);
    const { runtimeRoot } = deniedStateRoot();
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const stubs = tempDir("acp-session-probe-stub-");
    try {
      const adapter = new ClaudeCliAdapter({
        clock: { nowIso: () => "2026-08-12T00:00:00.000Z" } as never,
        capacityFile: join(STATE_ROOT, "capacity.fixture"),
        binary: claudeWithDescendant(stubs, "answer", marker),
      });
      const mark = sandboxed.length;
      const health = await adapter.probeSession({
        externalSessionId: randomUUID(), provider: "claude", model: "opus", effort: null, pid: null, workdir: runtimeRoot,
      });
      const probe = spawnedSince(mark)[0]!;
      const descendants = descendantPids(probe);
      expect(health, probe.stderr).toBe("HEALTHY");
      expect(descendants).toHaveLength(1);
      expect(alive(probe.pid!)).toBe(false);
      expect(alive(descendants[0]!)).toBe(false);
      expect(liveMembersOf(probe.pid!)).toEqual([]);
      expect(processesNaming(marker)).toEqual([]);
    } finally {
      killMarked(marker);
    }
  });

  it.for(["timeout", "abort"] as const)("the %s route reaps the probe's group the same way", async (route, ctx) => {
    requireSeatbelt(ctx);
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const stubs = tempDir("acp-session-probe-stub-");
    try {
      const controller = new AbortController();
      const mark = sandboxed.length;
      const pending = __testing.productionRunCli(claudeWithDescendant(stubs, "hang", marker), [marker], {
        cwd: undefined,
        timeoutMs: route === "timeout" ? 3_000 : 60_000,
        signal: controller.signal,
        reapProcessGroup: true,
      });
      expect(await waitFor(() => sandboxed.length > mark && descendantPids(sandboxed[mark]!).length === 1, 10_000)).toBe(true);
      const probe = sandboxed[mark]!;
      const descendant = descendantPids(probe)[0]!;
      expect(alive(descendant)).toBe(true);
      if (route === "abort") controller.abort();
      const result = await pending;
      expect(result.timedOut).toBe(route === "timeout");
      expect(result.processGroup).toEqual({ pgid: probe.pid, reaped: true, signalled: true, signals: expect.arrayContaining(["sent"]), delivered: expect.any(Number), ownership: "HELD", detail: null });
      expectConsistentReap(result.processGroup);
      expect(alive(cliPids(probe)[0]!)).toBe(false);
      expect(alive(probe.pid!)).toBe(false);
      expect(alive(descendant)).toBe(false);
      expect(liveMembersOf(probe.pid!)).toEqual([]);
      expect(processesNaming(marker)).toEqual([]);
    } finally {
      killMarked(marker);
    }
  });

  it("a holder lost before cleanup is never followed by a signal: UNAVAILABLE, the group named, its processes left", async (ctx) => {
    requireSeatbelt(ctx);
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const bystanderMarker = `acp-probe-bystander-${randomUUID()}`;
    const decoy = startBystander(bystanderMarker, true);
    const stubs = tempDir("acp-session-probe-stub-");
    try {
      const mark = sandboxed.length;
      const pending = __testing.productionRunCli(claudeWithDescendant(stubs, "hang", marker), [marker], {
        cwd: undefined,
        timeoutMs: 20_000,
        reapProcessGroup: true,
      });
      expect(await waitFor(() => sandboxed.length > mark && descendantPids(sandboxed[mark]!).length === 1, 10_000)).toBe(true);
      const probe = sandboxed[mark]!;
      const cli = cliPids(probe)[0]!;
      const descendant = descendantPids(probe)[0]!;
      // The holder dies from outside and is reaped before ACP asked for any cleanup.
      process.kill(probe.pid!, "SIGKILL");
      const result = await pending;
      const observed = {
        processGroup: result.processGroup,
        holderAlive: alive(probe.pid!),
        cliAlive: alive(cli),
        descendantAlive: alive(descendant),
        liveMembersOfProbeGroup: liveMembersOf(probe.pid!).length,
        decoyAlive: alive(decoy.pid!),
      };
      console.error(`WITNESS holder-lost ${JSON.stringify(observed)}`);
      expect(result.processGroup).toEqual({
        pgid: probe.pid, reaped: false, signalled: false, signals: [], delivered: 0, ownership: "HOLDER_LOST",
        detail: expect.stringContaining(`process group ${probe.pid} was not signalled and may still hold the probe's processes`),
      });
      expectConsistentReap(result.processGroup);
      expect(result.exitCode).toBeNull();
      // Nothing was signalled after the holder was gone: an after-the-fact "the pid is free, so the
      // group is ours" signal would have killed these.
      expect(observed.holderAlive).toBe(false);
      expect(observed.cliAlive).toBe(true);
      expect(observed.descendantAlive).toBe(true);
      expect(observed.liveMembersOfProbeGroup).toBe(2);
      expect(observed.decoyAlive).toBe(true);
    } finally {
      killMarked(marker);
      killMarked(bystanderMarker);
    }
  });

  it.for(["timeout", "abort"] as const)("a %s after the holder was lost sends no signal and reports the group unconfirmed", async (route, ctx) => {
    requireSeatbelt(ctx);
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const stubs = tempDir("acp-session-probe-stub-");
    try {
      const controller = new AbortController();
      const timeoutMs = 3_000;
      const started = Date.now();
      const mark = sandboxed.length;
      const pending = __testing.productionRunCli(claudeWithDescendant(stubs, "hang", marker), [marker], {
        cwd: undefined,
        timeoutMs: route === "timeout" ? timeoutMs : 60_000,
        signal: controller.signal,
        reapProcessGroup: true,
      });
      expect(await waitFor(() => sandboxed.length > mark && descendantPids(sandboxed[mark]!).length === 1, 2_000)).toBe(true);
      const probe = sandboxed[mark]!;
      const cli = cliPids(probe)[0]!;
      const descendant = descendantPids(probe)[0]!;
      if (route === "timeout") {
        // Lose the holder 300 ms before the timeout, so the timeout fires inside the 1 s drain window.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + timeoutMs - 300 - Date.now())));
        process.kill(probe.pid!, "SIGKILL");
      } else {
        process.kill(probe.pid!, "SIGKILL");
        expect(await waitFor(() => !alive(probe.pid!), 2_000)).toBe(true);
        controller.abort();
      }
      const result = await pending;
      expect(result.timedOut).toBe(route === "timeout");
      expect(result.processGroup).toEqual({
        pgid: probe.pid, reaped: false, signalled: false, signals: [], delivered: 0, ownership: "HOLDER_LOST",
        detail: expect.stringContaining(`process group ${probe.pid} was not signalled`),
      });
      expectConsistentReap(result.processGroup);
      // The route asked for the end, and nothing was sent: the probe's processes are still running.
      expect(alive(cli)).toBe(true);
      expect(alive(descendant)).toBe(true);
    } finally {
      killMarked(marker);
    }
  });

  it("a probe whose holder is lost is refused with the group named, not counted as cleaned up", async (ctx) => {
    requireSeatbelt(ctx);
    const { runtimeRoot } = deniedStateRoot();
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const stubs = tempDir("acp-session-probe-stub-");
    try {
      const adapter = new ClaudeCliAdapter({
        clock: { nowIso: () => "2026-08-12T00:00:00.000Z" } as never,
        capacityFile: join(STATE_ROOT, "capacity.fixture"),
        binary: claudeWithDescendant(stubs, "hang", marker),
      });
      const mark = sandboxed.length;
      const probing = adapter.probeSession({
        externalSessionId: randomUUID(), provider: "claude", model: "opus", effort: null, pid: null, workdir: runtimeRoot,
      });
      const outcome = probing.then(() => null, (error: unknown) => error);
      expect(await waitFor(() => sandboxed.length > mark && descendantPids(sandboxed[mark]!).length === 1, 10_000)).toBe(true);
      const probe = sandboxed[mark]!;
      process.kill(probe.pid!, "SIGKILL");
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toMatch(new RegExp(`^session probe UNAVAILABLE \\(HOLDER_LOST\\): .*process group ${probe.pid} was not signalled`));
      expect(alive(cliPids(probe)[0]!)).toBe(true);
    } finally {
      // The CLI stand-in's argv does not carry the marker here; its descendant's does.
      for (const spawned of sandboxed) for (const pid of cliPids(spawned)) if (alive(pid)) process.kill(pid, "SIGKILL");
      killMarked(marker);
    }
  });

  it("a descendant left by a CLI that already exited is ended while the holder still holds the group", async (ctx) => {
    requireSeatbelt(ctx);
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const bystanderMarker = `acp-probe-bystander-${randomUUID()}`;
    const decoy = startBystander(bystanderMarker, true);
    const stubs = tempDir("acp-session-probe-stub-");
    try {
      const mark = sandboxed.length;
      const result = await __testing.productionRunCli(claudeWithDescendant(stubs, "refuse", marker), [marker], {
        cwd: undefined,
        timeoutMs: 20_000,
        reapProcessGroup: true,
      });
      const probe = sandboxed[mark]!;
      const observed = {
        exitCode: result.exitCode,
        processGroup: result.processGroup,
        holderAlive: alive(probe.pid!),
        cliAlive: alive(cliPids(probe)[0]!),
        descendantAlive: alive(descendantPids(probe)[0]!),
        liveMembersOfProbeGroup: liveMembersOf(probe.pid!),
        decoyAlive: alive(decoy.pid!),
      };
      console.error(`WITNESS held-group-reap ${JSON.stringify(observed)}`);
      // The CLI's own status reaches the caller through the holder.
      expect(observed.exitCode).toBe(1);
      expect(result.processGroup).toEqual({ pgid: probe.pid, reaped: true, signalled: true, signals: expect.arrayContaining(["sent"]), delivered: expect.any(Number), ownership: "HELD", detail: null });
      expectConsistentReap(result.processGroup);
      expect(observed.holderAlive).toBe(false);
      expect(observed.cliAlive).toBe(false);
      expect(observed.descendantAlive).toBe(false);
      expect(observed.liveMembersOfProbeGroup).toEqual([]);
      expect(processesNaming(marker)).toEqual([]);
      expect(observed.decoyAlive).toBe(true);
    } finally {
      killMarked(marker);
      killMarked(bystanderMarker);
    }
  });

  it("a probe whose group cannot be confirmed empty is refused, names what may be left, and is not a cleanup", async () => {
    const unconfirmed = {
      pgid: 424242, reaped: false, signalled: false, signals: [], delivered: 0, ownership: "HOLDER_LOST" as const,
      detail: "the probe's holder (pid 424242) exited before ACP could end its group; process group 424242 was not signalled and may still hold the probe's processes",
    };
    __testing.setRunCli(async () => ({
      stdout: JSON.stringify({ type: "result", session_id: "x", result: "READY" }),
      stderr: "", exitCode: 0, timedOut: false, isolationEnforced: false, processGroup: unconfirmed,
    }));
    const world = await provisioningWorld((_root, stubs) => refusingClaude(stubs));
    try {
      const adapter = new ClaudeCliAdapter({
        clock: { nowIso: () => "2026-08-12T00:00:00.000Z" } as never,
        capacityFile: join(STATE_ROOT, "capacity.fixture"),
        binary: process.execPath,
      });
      // Even a CLI that answered READY with exit 0 is not HEALTHY when its group was not confirmed.
      await expect(adapter.probeSession({
        externalSessionId: randomUUID(), provider: "claude", model: "opus", effort: null, pid: null,
      })).rejects.toThrow(/UNAVAILABLE \(HOLDER_LOST\): .*process group 424242 was not signalled/);

      const refused = await world.provision();
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
      expect(String(refused.evidence["probeError"])).toContain("process group 424242 was not signalled");
      const sessions = claudeSessions(world.harness);
      expect(sessions.map((session) => session.lifecycle)).toEqual([SessionLifecycle.STOPPED]);
      expect(world.harness.cp.db.all(`SELECT * FROM assignments WHERE role_key = ?`, [roleKeyFor(Role.WORKER, { taskId: world.taskId })])).toEqual([]);
    } finally {
      __testing.setRunCli(null);
      world.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* #1077 N2-01 / N3-01 / N3-02 — the token is required, a failed attempt stays visible, output is the CLI's */
/* ------------------------------------------------------------------------------------------------ */

/** Records every group signal ACP's code sends, and lets a row make the first one fail as EPERM. */
const watchGroupSignals = (options: { failFirstWithEperm?: boolean; afterFirstAttempt?: () => void } = {}) => {
  const nativeKill = process.kill.bind(process);
  const attempts: { pid: number; signal: string | number }[] = [];
  let failed = false;
  const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (pid < 0 && signal !== 0 && signal !== undefined) {
      attempts.push({ pid, signal });
      if (attempts.length === 1) options.afterFirstAttempt?.();
      if (options.failFirstWithEperm && !failed) {
        failed = true;
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
      }
    }
    return nativeKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
  return { attempts, nativeKill, restore: () => spy.mockRestore() };
};

describe("ownership needs the holder's start token; a failed attempt is never a cleanup; the holder adds no output", () => {
  for (const mode of ["null", "mismatch-after-spawn"] as const) {
    it.for(["timeout", "abort"] as const)(`a ${mode} start token: the %s sends no signal and answers UNAVAILABLE naming the group`, async (route, ctx) => {
      requireSeatbelt(ctx);
      const marker = `acp-probe-descendant-${randomUUID()}`;
      const stubs = tempDir("acp-session-probe-stub-");
      tokenRead.mode = mode;
      tokenRead.spawned = false;
      const watch = watchGroupSignals();
      try {
        const controller = new AbortController();
        const mark = sandboxed.length;
        const pending = __testing.productionRunCli(claudeWithDescendant(stubs, "hang", marker), [marker], {
          cwd: undefined,
          timeoutMs: route === "timeout" ? 2_000 : 60_000,
          signal: controller.signal,
          reapProcessGroup: true,
        });
        expect(await waitFor(() => sandboxed.length > mark && descendantPids(sandboxed[mark]!).length === 1, 10_000)).toBe(true);
        tokenRead.spawned = true;
        const probe = sandboxed[mark]!;
        if (route === "abort") controller.abort();
        const result = await pending;
        const observed = { route, mode, attempts: watch.attempts, processGroup: result.processGroup, cliAlive: alive(cliPids(probe)[0]!) };
        console.error(`WITNESS unverifiable-token ${JSON.stringify(observed)}`);
        expect(watch.attempts).toEqual([]);
        expect(result.timedOut).toBe(route === "timeout");
        expect(result.processGroup).toEqual({
          pgid: probe.pid, reaped: false, signalled: false, signals: [], delivered: 0, ownership: "UNVERIFIABLE",
          detail: expect.stringContaining(`process group ${probe.pid} was not signalled and may still hold the probe's processes`),
        });
        expectConsistentReap(result.processGroup);
        // Left as it was: the probe's processes are still running, and the result says so.
        expect(observed.cliAlive).toBe(true);
      } finally {
        watch.restore();
        tokenRead.mode = "native";
        tokenRead.spawned = false;
        // The test, not ACP, removes what the probe was right to leave: the holder, its CLI and the
        // descendant, each found as a live member of this row's own group.
        const own = sandboxed[sandboxed.length - 1];
        if (own?.pid !== undefined) {
          for (const line of liveMembersOf(own.pid)) {
            const pid = Number(line.split(/\s+/)[0]);
            if (pid > 0) process.kill(pid, "SIGKILL");
          }
        }
        killMarked(marker);
      }
    });
  }

  it("a first attempt that fails stays in the record; a later delivered one ends the group and the cleanup counts", async (ctx) => {
    requireSeatbelt(ctx);
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const stubs = tempDir("acp-session-probe-stub-");
    const watch = watchGroupSignals({ failFirstWithEperm: true });
    try {
      const mark = sandboxed.length;
      const result = await __testing.productionRunCli(claudeWithDescendant(stubs, "refuse", marker), [marker], {
        cwd: undefined,
        timeoutMs: 20_000,
        reapProcessGroup: true,
      });
      const probe = sandboxed[mark]!;
      console.error(`WITNESS injected-first-eperm ${JSON.stringify({ attempts: watch.attempts, processGroup: result.processGroup })}`);
      expect(result.processGroup!.signals[0]).toBe("EPERM");
      expect(result.processGroup!.delivered).toBeGreaterThan(0);
      expect(result.processGroup).toMatchObject({ pgid: probe.pid, reaped: true, ownership: "HELD", detail: null });
      expectConsistentReap(result.processGroup);
      expect(watch.attempts.length).toBe(result.processGroup!.signals.length);
      expect(alive(descendantPids(probe)[0]!)).toBe(false);
    } finally {
      watch.restore();
      killMarked(marker);
    }
  });

  it("a group already dead to a real kernel EPERM before ACP's first attempt is not counted as cleaned up", async (ctx) => {
    requireSeatbelt(ctx);
    const marker = `acp-probe-descendant-${randomUUID()}`;
    const stubs = tempDir("acp-session-probe-stub-");
    const watch = watchGroupSignals();
    try {
      const controller = new AbortController();
      const mark = sandboxed.length;
      const pending = __testing.productionRunCli(claudeWithDescendant(stubs, "hang", marker), [marker], {
        cwd: undefined,
        timeoutMs: 60_000,
        signal: controller.signal,
        reapProcessGroup: true,
      });
      expect(await waitFor(() => sandboxed.length > mark && descendantPids(sandboxed[mark]!).length === 1, 10_000)).toBe(true);
      const pgid = sandboxed[mark]!.pid!;
      const before: { groupAnswer?: string } = {};
      // Queued ahead of ACP's own check-phase turn: the whole group dies from outside, and this turn
      // waits until the kernel answers EPERM for it — every member a zombie, the holder still unreaped.
      setImmediate(() => {
        watch.nativeKill(-pgid, "SIGKILL");
        const deadline = Date.now() + 2_000;
        for (;;) {
          try {
            watch.nativeKill(-pgid, 0);
          } catch (error) {
            before.groupAnswer = (error as NodeJS.ErrnoException).code;
            break;
          }
          if (Date.now() > deadline) break;
        }
      });
      controller.abort();
      const result = await pending;
      console.error(`WITNESS kernel-eperm ${JSON.stringify({ before, attempts: watch.attempts, processGroup: result.processGroup })}`);
      expect(before.groupAnswer).toBe("EPERM");
      expect(result.processGroup!.reaped).toBe(false);
      expect(result.processGroup!.delivered).toBe(0);
      expect(result.processGroup!.detail).toEqual(expect.stringContaining(`process group ${pgid}`));
      expectConsistentReap(result.processGroup);
    } finally {
      watch.restore();
      killMarked(marker);
    }
  });

  it.for(["completion", "timeout", "abort", "recorder-failure"] as const)(
    "%s with the token lost between attempts: answers at once as UNAVAILABLE, keeping the failed attempt",
    async (route, ctx) => {
      requireSeatbelt(ctx);
      const marker = `acp-probe-descendant-${randomUUID()}`;
      const stubs = tempDir("acp-session-probe-stub-");
      tokenRead.mode = "native";
      tokenRead.spawned = false;
      // A live holder and group; the first attempt fails, and the token stops reading after it.
      const watch = watchGroupSignals({ failFirstWithEperm: true, afterFirstAttempt: () => { tokenRead.mode = "null"; } });
      const mark = sandboxed.length;
      try {
        const controller = new AbortController();
        const started = Date.now();
        const pending = __testing.productionRunCli(claudeWithDescendant(stubs, route === "completion" ? "refuse" : "hang", marker), [marker], {
          cwd: undefined,
          timeoutMs: route === "timeout" ? 200 : 60_000,
          signal: controller.signal,
          reapProcessGroup: true,
          ...(route === "recorder-failure" ? { onSpawn: () => { throw new Error("the spawn recorder refused"); } } : {}),
        });
        let requestedAt = started + (route === "timeout" ? 200 : 0);
        if (route === "abort") {
          expect(await waitFor(() => sandboxed.length > mark && descendantPids(sandboxed[mark]!).length === 1, 10_000)).toBe(true);
          requestedAt = Date.now();
          controller.abort();
        }
        const outcome = await Promise.race([
          pending,
          new Promise<"PENDING">((resolve) => setTimeout(() => resolve("PENDING"), (route === "completion" ? 5_000 : 2_000) + (requestedAt - started))),
        ]);
        const settledAt = Date.now();
        const holder = sandboxed[mark]?.pid;
        const observed = {
          route,
          outcome: outcome === "PENDING" ? "PENDING" : outcome.processGroup,
          attempts: watch.attempts,
          settleMs: settledAt - requestedAt,
          holderAliveAtSettle: holder !== undefined && alive(holder),
        };
        console.error(`WITNESS token-between-attempts ${JSON.stringify(observed)}`);
        expect(outcome).not.toBe("PENDING");
        if (outcome === "PENDING") return;
        if (route !== "completion") expect(observed.settleMs).toBeLessThan(1_000);
        expect(outcome.processGroup).toEqual({
          pgid: holder, reaped: false, signalled: true, signals: ["EPERM"], delivered: 0, ownership: "UNVERIFIABLE",
          detail: expect.stringContaining(`process group ${holder} got 1 attempt(s), 0 delivered (EPERM), and no further signal`),
        });
        expectConsistentReap(outcome.processGroup);
        expect(watch.attempts).toHaveLength(1);
        // It did not wait on the holder: still live when the probe answered.
        expect(observed.holderAliveAtSettle).toBe(true);
      } finally {
        watch.restore();
        tokenRead.mode = "native";
        const own = sandboxed[mark];
        if (own?.pid !== undefined) {
          for (const line of liveMembersOf(own.pid)) {
            const pid = Number(line.split(/\s+/)[0]);
            if (pid > 0) process.kill(pid, "SIGKILL");
          }
        }
        killMarked(marker);
      }
    },
  );

  it.for(["exit0", "exit7", "sigterm"] as const)("%s: stdout, stderr and status are what running the CLI directly answers", async (mode, ctx) => {
    requireSeatbelt(ctx);
    const stubs = tempDir("acp-session-probe-stub-");
    const binary = join(stubs, "claude-output.cjs");
    writeFileSync(binary, `#!${process.execPath}
const mode = process.argv[2];
process.stdout.write("stdout line\\nno trailing newline", () => {
  process.stderr.write("stderr line\\n", () => {
    if (mode === "exit0") process.exit(0);
    if (mode === "exit7") process.exit(7);
    process.kill(process.pid, "SIGTERM");
  });
});
`);
    chmodSync(binary, 0o700);
    const direct = await __testing.productionRunCli(binary, [mode], { cwd: undefined, timeoutMs: 10_000 });
    const held = await __testing.productionRunCli(binary, [mode], { cwd: undefined, timeoutMs: 10_000, reapProcessGroup: true });
    console.error(`WITNESS output-parity ${JSON.stringify({ mode, direct: { stdout: direct.stdout, stderr: direct.stderr, exitCode: direct.exitCode }, held: { stdout: held.stdout, stderr: held.stderr, exitCode: held.exitCode } })}`);
    expect(direct.stdout).toBe("stdout line\nno trailing newline");
    expect(direct.stderr).toBe("stderr line\n");
    expect(held.stdout).toBe(direct.stdout);
    expect(held.stderr).toBe(direct.stderr);
    expect(held.exitCode).toBe(direct.exitCode);
    expect(direct.exitCode).toBe(mode === "exit0" ? 0 : mode === "exit7" ? 7 : null);
    expectConsistentReap(held.processGroup);
    expect(held.processGroup!.reaped).toBe(true);
  });
});
