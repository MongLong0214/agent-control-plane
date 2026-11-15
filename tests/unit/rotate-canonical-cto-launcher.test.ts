import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
const stragglers: ChildProcess[] = [];
afterEach(() => {
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/**
 * The launcher's order (handoff -> rotate -> start -> verify -> stop old) and its two failure exits, against stubs of
 * agentctl, claude and tmux that record what they were asked. The switchover itself is `a-canonical-cto-rotation`'s.
 */
const LAUNCHER = fileURLToPath(new URL("../../scripts/rotate-canonical-cto.mjs", import.meta.url));
const OLD = "58cac5c6-0000-4000-8000-0000000000c1";
const NEW = "36276d16-0000-4000-8000-0000000000c2";
const PROJECT = "launch-project";

const stub = (path: string, body: string) => {
  writeFileSync(path, `#!/usr/bin/env node\nconst fs = require("node:fs");\n${body}\n`);
  chmodSync(path, 0o755);
};

const fixture = async (mode: "claims" | "never-claims" | "claims-deaf") => {
  const dir = tempDir("acp-rotlaunch-");
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  for (const d of [cwd, home, join(dir, "state")]) mkdirSync(d, { recursive: true });
  const log = join(dir, "calls.log");
  const db = join(dir, "acp.json");
  writeFileSync(db, JSON.stringify({ holderSessionUuid: OLD, generation: 1, binding: { generation: 1, sessionId: "ses_old" },
    buzz: { verdict: "ADMITTED", sessionId: "ses_old", generation: 1 } }));
  const previousArgs = ["/rt/agentctl.js", "attach", "canonical-cto", "--claimed-session-id", OLD, "--project-id", PROJECT, "--expected-binding-generation", "1"];
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [cwd]: { mcpServers: { "acp-cto": { type: "stdio", command: "/rt/node", args: previousArgs, env: {} } } } } }));
  const handoff = join(dir, "handoff.json");
  writeFileSync(handoff, JSON.stringify({ projectStatus: "green", activeManifestDigest: null, recentDecisions: [], openBlockers: [], queuedWork: [],
    repositoryFacts: [], knownRisks: [], recommendedNextAction: "continue" }));
  const record = `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([require("node:path").basename(process.argv[1]), ...process.argv.slice(2)]) + "\\n");`;
  stub(join(dir, "agentctl"), `${record}
const db = ${JSON.stringify(db)}; const s = JSON.parse(fs.readFileSync(db, "utf8")); const a = process.argv.slice(2);
const flag = (n) => a[a.indexOf(n) + 1];
if (a[1] === "status") { process.stdout.write(JSON.stringify(s)); process.exit(0); }
if (flag("--to") === ${JSON.stringify(NEW)} && a.includes("--handoff")) { s.pending = true; fs.writeFileSync(db, JSON.stringify(s));
  process.stdout.write(JSON.stringify({ outcome: "SWITCHOVER_PENDING", transferId: "t1", toGeneration: s.generation + 1 })); process.exit(0); }
if (flag("--to") === ${JSON.stringify(OLD)} && s.pending && s.generation === 1) { s.pending = false; fs.writeFileSync(db, JSON.stringify(s));
  process.stdout.write(JSON.stringify({ outcome: "ROLLED_BACK", transferId: "t1", holderSessionUuid: ${JSON.stringify(OLD)}, generation: 1 })); process.exit(0); }
process.stdout.write(JSON.stringify({ ok: false, reasonCode: "BINDING_GENERATION_STALE" })); process.exit(1);`);
  stub(join(dir, "claude"), record);
  const claimed = mode === "never-claims" ? "" : `const s = JSON.parse(fs.readFileSync(${JSON.stringify(db)}, "utf8"));
if (process.argv[2] === "new-session") { Object.assign(s, { holderSessionUuid: ${JSON.stringify(NEW)}, generation: 2, binding: { generation: 2, sessionId: "ses_new" },
  buzz: ${mode === "claims" ? `{ verdict: "ADMITTED", sessionId: "ses_new", generation: 2 }` : `{ verdict: "EXCLUDED", reason: "NO_LIVE_SESSION" }`} }); fs.writeFileSync(${JSON.stringify(db)}, JSON.stringify(s)); }`;
  stub(join(dir, "tmux"), `${record}\n${claimed}`);
  // The old conversation's claude process: its command line names its conversation.
  const old = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", OLD], { stdio: "ignore" });
  stragglers.push(old);
  await once(old, "spawn");
  const launch = () => bounded([LAUNCHER, "--project", PROJECT, "--to", NEW, "--expected-generation", "1", "--cwd", cwd,
    "--old-pid", String(old.pid), "--tmux-session", "acp-rot-test", "--handoff", handoff, "--timeout-ms", "600", "--poll-ms", "50"], {
    PATH: process.env["PATH"] ?? "", HOME: home, ACP_STATE_DIR: join(dir, "state"), ACP_AGENTCTL: join(dir, "agentctl"),
    CLAUDE_BIN: join(dir, "claude"), TMUX_BIN: join(dir, "tmux"), ACP_OPERATOR_TOKEN: "operator-token-for-test",
  });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const steps = (stdout: string) => stdout.trim().split("\n").map((line) => JSON.parse(line) as { step: string });
  return { dir, cwd, old, launch, calls, steps, previousArgs };
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

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("rotate-canonical-cto.mjs: handoff -> rotate -> start -> verify -> stop old", () => {
  it("starts the new conversation on the issued generation, verifies attach and Buzz, then stops the old process", async () => {
    const f = await fixture("claims");
    const result = await f.launch();
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(f.steps(result.stdout).map((line) => line.step)).toEqual(["handoff", "rotate", "start", "verify", "stop"]);
    const calls = f.calls();
    const add = calls.find((call) => call[0] === "claude" && call[2] === "add")!;
    expect(add.slice(add.indexOf("--") + 1)).toEqual(["/rt/node", ...f.previousArgs.map((arg) => arg === OLD ? NEW : arg === "1" ? "2" : arg)]);
    expect(calls.findIndex((call) => call[0] === "agentctl" && call[2] === "rotate")).toBeLessThan(calls.findIndex((call) => call[0] === "tmux"));
    const shell = readFileSync(join(f.dir, "state", "rotations", `${PROJECT}-${NEW}.sh`), "utf8");
    expect(shell).toContain("unset ACP_OPERATOR_TOKEN");
    expect(shell).toContain(`'--session-id' '${NEW}'`);
    expect(shell).not.toContain("operator-token-for-test");
    for (let i = 0; i < 50 && running(f.old.pid!); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(running(f.old.pid!)).toBe(false);
  });

  it("start failure: the new conversation never claims, so the switchover is rolled back and the old process keeps running", async () => {
    const f = await fixture("never-claims");
    const result = await f.launch();
    expect(result.code, result.stdout).toBe(2);
    const calls = f.calls();
    expect(calls.some((call) => call[0] === "agentctl" && call.includes("--to") && call[call.indexOf("--to") + 1] === OLD && !call.includes("--handoff"))).toBe(true);
    expect(calls.some((call) => call[0] === "tmux" && call[1] === "kill-session")).toBe(true);
    const restored = calls.filter((call) => call[0] === "claude" && call[2] === "add").at(-1)!;
    expect(restored.slice(restored.indexOf("--") + 1)).toEqual(["/rt/node", ...f.previousArgs]);
    expect(running(f.old.pid!)).toBe(true);
  });

  it("claimed but not receiving Buzz: it may already have acted, so nothing is rolled back and the old process is not stopped", async () => {
    const f = await fixture("claims-deaf");
    const result = await f.launch();
    expect(result.code, result.stdout).toBe(3);
    expect(f.calls().some((call) => call[0] === "agentctl" && call.includes(OLD))).toBe(false);
    expect(running(f.old.pid!)).toBe(true);
    expect(existsSync(join(f.dir, "state", "rotations"))).toBe(true);
  });
});
