import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
const stragglers: number[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // Never 0 or 1: kill(0) and kill(-0) would signal this runner's own process group.
  for (const pid of stragglers.splice(0)) if (pid > 1) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  for (const pgid of groups.splice(0)) if (pgid > 1) try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
});

/**
 * The launcher's order (handoff -> rotate -> stop old, its exit and its children's confirmed -> start -> verify) and
 * its failure exits, against stubs of agentctl, claude and tmux that record what they were asked. The old
 * conversation is a real process with a real child, so "exited" is the process table's answer. The switchover
 * itself is `a-canonical-cto-rotation`'s.
 */
const LAUNCHER = fileURLToPath(new URL("../../scripts/rotate-canonical-cto.mjs", import.meta.url));
const OLD = "58cac5c6-0000-4000-8000-0000000000c1";
const NEW = "36276d16-0000-4000-8000-0000000000c2";
const PROJECT = "launch-project";

type Mode = "claims" | "never-claims" | "claims-deaf" | "claims-unreceived" | "owned-work";

const stub = (path: string, body: string) => {
  writeFileSync(path, `#!/usr/bin/env node\nconst fs = require("node:fs");\n${body}\n`);
  chmodSync(path, 0o755);
};
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** `childMs`: how long the old conversation's child (a shell writer of its own) outlives the old process. */
const fixture = async (initial: Mode, childMs = 1_200) => {
  const dir = tempDir("acp-rotlaunch-");
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  for (const d of [cwd, home, join(dir, "state")]) mkdirSync(d, { recursive: true });
  const log = join(dir, "calls.log");
  const db = join(dir, "acp.json");
  const modeFile = join(dir, "mode");
  const childPidFile = join(dir, "child.pid");
  writeFileSync(modeFile, initial);
  writeFileSync(db, JSON.stringify({ holderSessionUuid: OLD, generation: 1, binding: { generation: 1, sessionId: "ses_old", lifecycle: "READY", liveRuns: [] },
    buzz: { verdict: "ADMITTED", sessionId: "ses_old", generation: 1 }, rotations: [] }));
  const previousArgs = ["/rt/agentctl.js", "attach", "canonical-cto", "--claimed-session-id", OLD, "--project-id", PROJECT, "--expected-binding-generation", "1"];
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [cwd]: { mcpServers: { "acp-cto": { type: "stdio", command: "/rt/node", args: previousArgs, env: {} } } } } }));
  const handoff = join(dir, "handoff.json");
  writeFileSync(handoff, JSON.stringify({ projectStatus: "green", activeManifestDigest: null, recentDecisions: [], openBlockers: [], queuedWork: [],
    repositoryFacts: [], knownRisks: [], recommendedNextAction: "continue" }));
  const record = `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([require("node:path").basename(process.argv[1]), ...process.argv.slice(2)]) + "\\n");`;
  const mode = `fs.readFileSync(${JSON.stringify(modeFile)}, "utf8")`;
  stub(join(dir, "agentctl"), `${record}
const db = ${JSON.stringify(db)}; const s = JSON.parse(fs.readFileSync(db, "utf8")); const a = process.argv.slice(2);
const flag = (n) => a[a.indexOf(n) + 1];
if (a[1] === "status") { process.stdout.write(JSON.stringify(s)); process.exit(0); }
if (flag("--to") === ${JSON.stringify(NEW)} && a.includes("--handoff") && !s.rotations.some((r) => r.state === "PENDING") && s.generation === 1) {
  s.rotations = [{ transferId: "t1", state: "PENDING", fromSessionUuid: ${JSON.stringify(OLD)}, toSessionUuid: ${JSON.stringify(NEW)}, fromGeneration: 1, toGeneration: 2 }];
  s.binding.lifecycle = "DRAINING"; if (${mode} === "owned-work") s.binding.liveRuns = ["run_raced"];
  fs.writeFileSync(db, JSON.stringify(s));
  process.stdout.write(JSON.stringify({ outcome: "SWITCHOVER_PENDING", transferId: "t1", toGeneration: 2 })); process.exit(0); }
process.stdout.write(JSON.stringify({ ok: false, reasonCode: "CONFLICT" })); process.exit(1);`);
  stub(join(dir, "claude"), record);
  // tmux records, at new-session, whether the old process and its child were still in the process table.
  stub(join(dir, "tmux"), `${record}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (process.argv[2] === "new-session") {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(["observed", { oldAlive: alive(Number(process.env.TEST_OLD_PID)), childAlive: alive(Number(fs.readFileSync(${JSON.stringify(childPidFile)}, "utf8"))) }]) + "\\n");
  const m = ${mode};
  if (m === "claims" || m === "claims-deaf" || m === "claims-unreceived") {
    const s = JSON.parse(fs.readFileSync(${JSON.stringify(db)}, "utf8"));
    // The registry's verdict, and beside it what the daemon's subscriber and ingress actually show.
    const received = { subscriber: { connected: true, liveness: "LIVE", delivering: true }, ingress: { listening: true } };
    const closed = { subscriber: { connected: false, liveness: "STALE", delivering: false }, ingress: { listening: false } };
    Object.assign(s, { holderSessionUuid: ${JSON.stringify(NEW)}, generation: 2, binding: { generation: 2, sessionId: "ses_new", lifecycle: "READY", liveRuns: [] },
      buzz: m === "claims-deaf" ? { verdict: "EXCLUDED", reason: "NO_LIVE_SESSION" }
        : { verdict: "ADMITTED", sessionId: "ses_new", generation: 2, reception: m === "claims" ? received : closed } });
    s.rotations[0].state = "ACKED"; fs.writeFileSync(${JSON.stringify(db)}, JSON.stringify(s));
  }
}`);
  // The old conversation's claude process, leading its own process group as a terminal job or a tmux pane does: its
  // command line names its conversation, and it has a child of its own in that group that outlives it by `childMs`
  // (a shell writer it started), which SIGTERM to the old process does not reach. On SIGUSR1 the child starts a
  // grandchild in the same group and exits. None inherits this process's env (R1154-01).
  const grandchildPidFile = join(dir, "grandchild.pid");
  const childScript = join(dir, "child.js");
  writeFileSync(childScript, `process.on("SIGUSR1", () => {
  const g = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", env: {} });
  require("node:fs").writeFileSync(${JSON.stringify(grandchildPidFile)}, String(g.pid)); process.exit(0);
});
setTimeout(() => {}, ${childMs});\n`);
  const old = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore", env: {} });
require("node:fs").writeFileSync(${JSON.stringify(childPidFile)}, String(c.pid)); setInterval(() => {}, 1e6);`, OLD], { stdio: "ignore", env: {}, detached: true });
  children.push(old);
  groups.push(old.pid!);
  await once(old, "spawn");
  /** The pid a process wrote to `file`, once it is there whole. */
  const pidIn = async (file: string) => {
    for (let i = 0; i < 250; i++) {
      const pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no pid in ${file}`);
  };
  const childPid = await pidIn(childPidFile);
  stragglers.push(childPid);
  const launch = (stopTimeoutMs = 10_000) => bounded([LAUNCHER, "--project", PROJECT, "--to", NEW, "--expected-generation", "1", "--cwd", cwd,
    "--old-pid", String(old.pid), "--tmux-session", "acp-rot-test", "--handoff", handoff, "--timeout-ms", "600", "--poll-ms", "50",
    "--stop-timeout-ms", String(stopTimeoutMs)], {
    PATH: process.env["PATH"] ?? "", HOME: home, ACP_STATE_DIR: join(dir, "state"), ACP_AGENTCTL: join(dir, "agentctl"),
    CLAUDE_BIN: join(dir, "claude"), TMUX_BIN: join(dir, "tmux"), ACP_OPERATOR_TOKEN: "operator-token-for-test", TEST_OLD_PID: String(old.pid),
  });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown[]);
  const steps = (stdout: string) => stdout.trim().split("\n").map((line) => JSON.parse(line) as { step: string } & Record<string, unknown>);
  const setMode = (next: Mode) => writeFileSync(modeFile, next);
  /** The child starts a grandchild in the old process group and exits; the grandchild's pid. */
  const handOffToGrandchild = async () => {
    process.kill(childPid, "SIGUSR1");
    const grandchild = await pidIn(grandchildPidFile);
    stragglers.push(grandchild);
    for (let i = 0; i < 200 && running(childPid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return grandchild;
  };
  return { dir, cwd, old, childPid, launch, calls, steps, previousArgs, setMode, handOffToGrandchild };
};

/** The launcher as a child of its own, killed at 30 s so a wedge names itself. */
const bounded = (argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });

const agentctlCalls = (calls: unknown[][]) => calls.filter((call) => call[0] === "agentctl") as string[][];
const rotatesTo = (calls: unknown[][], uuid: string) => agentctlCalls(calls).filter((call) => call[1] === "canonical-cto" && call[2] === "rotate" && call[call.indexOf("--to") + 1] === uuid);

describe("rotate-canonical-cto.mjs: handoff -> rotate -> stop old (confirmed, with its children) -> start -> verify", () => {
  it("starts the new conversation only after the old process and its child have exited, on the issued generation, then verifies attach and Buzz", async () => {
    const f = await fixture("claims");
    const result = await f.launch();
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(f.steps(result.stdout).map((line) => line.step)).toEqual(["handoff", "rotate", "stop", "start", "verify"]);
    const calls = f.calls();
    // The new holder is started only once the old writer and the child it left behind are gone from the process table.
    expect(calls.find((call) => call[0] === "observed")).toEqual(["observed", { oldAlive: false, childAlive: false }]);
    const add = calls.find((call) => call[0] === "claude" && call[2] === "add") as string[];
    // The entry outlives the rotation, so it pins no generation: the relay reads the next one (here the issued 2).
    expect(add.slice(add.indexOf("--") + 1)).toEqual(["/rt/node", ...f.previousArgs.map((arg) => arg === OLD ? NEW : arg === "1" ? "auto" : arg)]);
    expect(calls.findIndex((call) => call[0] === "agentctl" && call[2] === "rotate")).toBeLessThan(calls.findIndex((call) => call[0] === "tmux"));
    const shell = readFileSync(join(f.dir, "state", "rotations", `${PROJECT}-${NEW}.sh`), "utf8");
    expect(shell).toContain("unset ACP_OPERATOR_TOKEN");
    expect(shell).toContain(`'--session-id' '${NEW}'`);
    expect(shell).toContain(`'--messaging-socket-path' '${join(f.dir, "state", `cc-session-canonical-cto-${PROJECT}.sock`)}'`);
    expect(shell).toContain("previousHolderInFlight");
    expect(shell).not.toContain("operator-token-for-test");
    expect(running(f.old.pid!)).toBe(false);
  });

  it("an old writer that outlives the stop timeout: the new conversation is never started, and nothing else is signalled", async () => {
    const f = await fixture("claims", 60_000);
    const result = await f.launch(800);
    expect(result.code, result.stdout).toBe(4);
    expect(f.steps(result.stdout).at(-1)).toMatchObject({ step: "stop", remaining: [f.childPid] });
    const calls = f.calls();
    expect(calls.some((call) => call[0] === "tmux")).toBe(false);
    expect(calls.some((call) => call[0] === "claude" && call[2] === "add")).toBe(false);
    // The switchover stays pending with the old holder fenced: nothing rotates back to it, and its child is untouched.
    expect(rotatesTo(calls, OLD)).toEqual([]);
    expect(running(f.old.pid!)).toBe(false);
    expect(running(f.childPid)).toBe(true);
  });

  it("owned work at the boundary: the old process is not stopped and the new conversation is never started", async () => {
    const f = await fixture("owned-work");
    const result = await f.launch();
    expect(result.code, result.stdout).toBe(4);
    expect(f.steps(result.stdout).at(-1)).toMatchObject({ step: "boundary", liveRuns: ["run_raced"] });
    expect(f.calls().some((call) => call[0] === "tmux")).toBe(false);
    expect(running(f.old.pid!)).toBe(true);
  });

  it("start failure: the new conversation never claims, so it is fenced and the switchover stays pending; nothing goes back to the old conversation, and running the launcher again completes it", async () => {
    const f = await fixture("never-claims", 0);
    const result = await f.launch();
    expect(result.code, result.stdout).toBe(2);
    const calls = f.calls();
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-session")).toBe(true);
    // No rollback to generation 1: no rotate back to the old conversation, and its acp-cto entry is not restored.
    expect(rotatesTo(calls, OLD)).toEqual([]);
    const adds = calls.filter((call) => call[0] === "claude" && call[2] === "add") as string[][];
    expect(adds.every((call) => call.includes(NEW) && !call.includes(OLD))).toBe(true);
    expect(running(f.old.pid!)).toBe(false);
    // Running it again resumes the pending switchover: no second rotate, the old process is already gone, the new one claims.
    f.setMode("claims");
    const again = await f.launch();
    expect(again.code, again.stdout).toBe(0);
    expect(f.steps(again.stdout).map((line) => line.step)).toEqual(["handoff", "stop", "start", "verify"]);
    expect(f.steps(again.stdout)[1]).toMatchObject({ step: "stop", alreadyGone: true });
    expect(rotatesTo(f.calls(), NEW)).toHaveLength(1);
    expect(rotatesTo(f.calls(), OLD)).toEqual([]);
  });

  it("a resumed rotation re-checks the processes the earlier run was still waiting for: a child of the old process that outlived it keeps the successor from starting", async () => {
    const f = await fixture("claims", 60_000);
    expect((await f.launch(800)).code).toBe(4);
    // The old process is gone and nothing names the old conversation, but its child is still running.
    expect(running(f.old.pid!)).toBe(false);
    expect(running(f.childPid)).toBe(true);
    const again = await f.launch(800);
    expect(again.code, again.stdout).toBe(4);
    expect(f.steps(again.stdout).at(-1)).toMatchObject({ step: "stop", remaining: [f.childPid] });
    expect(f.calls().some((call) => call[0] === "tmux")).toBe(false);
    // Once it has exited, the same command resumes the switchover and starts the successor.
    process.kill(f.childPid, "SIGKILL");
    for (let i = 0; i < 100 && running(f.childPid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const resumed = await f.launch(800);
    expect(resumed.code, resumed.stdout).toBe(0);
    expect(f.steps(resumed.stdout).map((line) => line.step)).toEqual(["handoff", "stop", "start", "verify"]);
    expect(rotatesTo(f.calls(), NEW)).toHaveLength(1);
  });

  it("a resumed rotation awaits the old process group, not only the pids it saved: a grandchild started there after the first run keeps the successor from starting", async () => {
    const f = await fixture("claims", 60_000);
    expect((await f.launch(800)).code).toBe(4);
    // Between the two runs the saved child starts a grandchild in the old process group and exits, so no saved pid is
    // left and nothing names the old conversation; the grandchild is a writer of the old tree all the same.
    const grandchild = await f.handOffToGrandchild();
    expect([running(f.old.pid!), running(f.childPid), running(grandchild)]).toEqual([false, false, true]);
    const again = await f.launch(800);
    expect(again.code, again.stdout).toBe(4);
    expect(f.steps(again.stdout).at(-1)).toMatchObject({ step: "stop", groups: [f.old.pid] });
    expect(f.calls().some((call) => call[0] === "tmux")).toBe(false);
    // Once the group is empty, the same command resumes the switchover and starts the successor.
    process.kill(grandchild, "SIGKILL");
    for (let i = 0; i < 100 && running(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const resumed = await f.launch(800);
    expect(resumed.code, resumed.stdout).toBe(0);
    expect(f.steps(resumed.stdout).map((line) => line.step)).toEqual(["handoff", "stop", "start", "verify"]);
  });

  it("claimed and judged ADMITTED, but the subscriber and ingress show no reception: verification fails and success is never reported", async () => {
    const f = await fixture("claims-unreceived", 0);
    const result = await f.launch();
    expect(result.code, result.stdout).toBe(3);
    expect(f.steps(result.stdout).at(-1)).toMatchObject({ step: "verify", buzz: { verdict: "ADMITTED", reception: { subscriber: { connected: false } } } });
    expect(rotatesTo(f.calls(), OLD)).toEqual([]);
  });

  it("claimed but not receiving Buzz: it may already have acted, so nothing is rolled back", async () => {
    const f = await fixture("claims-deaf", 0);
    const result = await f.launch();
    expect(result.code, result.stdout).toBe(3);
    expect(f.calls().some((call) => call[0] === "agentctl" && call.includes(OLD))).toBe(false);
    expect(f.calls().some((call) => call[0] === "tmux" && call[1] === "kill-session")).toBe(false);
    expect(existsSync(join(f.dir, "state", "rotations"))).toBe(true);
  });
});
