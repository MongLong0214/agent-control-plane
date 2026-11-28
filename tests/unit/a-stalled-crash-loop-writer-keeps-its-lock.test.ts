import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { withRecordLock } from "../../src/daemon/crash-loop.ts";

/**
 * #1496 — the lock every read-modify-write of `crash-loop.json` runs under. A start that stalls inside it (a
 * stopped process, a slow disk) still owns it, however old the lock looks; one that exited does not. A lock
 * taken from a stalled owner by age, then removed by that owner when it resumed, let two starts rewrite the
 * record at once, and a `lastRefusal` or its send claim could be lost, so the CEO was told twice.
 *
 * Each owner is a separate process holding the lock until the test lets it go, through marker files.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const crashLoopModule = join(repositoryRoot, "src/daemon/crash-loop.ts");

const OWNER = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [modulePath, stateDir, signals, name] = process.argv.slice(2);
const { withRecordLock } = await import(modulePath);
const mark = (what, text = "") => writeFileSync(join(signals, name + "." + what), text);
mark("trying");
try {
  withRecordLock(stateDir, () => {
    mark("held");
    while (!existsSync(join(signals, name + ".go"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  });
  mark("released");
} catch (error) {
  mark("refused", String(error));
}
`;

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const newState = (): { stateDir: string; signals: string; script: string } => {
  const root = mkdtempSync(join(tmpdir(), "acp-crash-loop-lock-"));
  dirs.push(root);
  const stateDir = join(root, "state");
  const signals = join(root, "signals");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(signals);
  const script = join(root, "owner.mjs");
  writeFileSync(script, OWNER);
  return { stateDir, signals, script };
};

const until = async (condition: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  return true;
};

const owner = (state: ReturnType<typeof newState>, name: string) => {
  const child = spawn(process.execPath, ["--import", "tsx", state.script, crashLoopModule, state.stateDir, state.signals, name], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  const marked = (what: string): boolean => existsSync(join(state.signals, `${name}.${what}`));
  return {
    child,
    exited,
    marked,
    reached: async (what: string, ms = 20_000): Promise<void> => {
      const seen = await until(() => marked(what), ms);
      expect(seen, `${name} never reached ${what}; refused: ${marked("refused")}\n${stderr}`).toBe(true);
    },
    go: (): void => writeFileSync(join(state.signals, `${name}.go`), ""),
  };
};

describe("the crash-loop record lock belongs to its owner until that owner exits (#1496)", () => {
  it("a delayed owner keeps the lock however old it looks, and its release cannot free the lock its successor took", async () => {
    const state = newState();
    const a = owner(state, "a");
    await a.reached("held");

    // A has stalled for an hour, by the lock's clock. Age says nothing about whether A is still there.
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(state.stateDir, ".crash-loop.lock"), anHourAgo, anHourAgo);

    const b = owner(state, "b");
    await b.reached("trying");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
    expect(b.marked("held"), "B took the lock from an owner that is still running").toBe(false);
    expect(b.marked("refused")).toBe(false);

    // A resumes and lets go; B, still waiting, takes it.
    a.go();
    await a.exited;
    expect(a.marked("released")).toBe(true);
    await b.reached("held", 3_000);

    // A's release is behind it: B's lock stands, and a third start is refused while B holds.
    expect(() => withRecordLock(state.stateDir, () => "c")).toThrow(/another start/);

    b.go();
    await b.exited;
    expect(b.marked("released")).toBe(true);
    expect(withRecordLock(state.stateDir, () => "c")).toBe("c");
  }, 60_000);

  it("an owner that exited while holding the lock leaves it to the next start at once", async () => {
    const state = newState();
    const a = owner(state, "a");
    await a.reached("held");

    a.child.kill("SIGKILL");
    await a.exited;
    expect(a.marked("released")).toBe(false);

    const started = performance.now();
    expect(withRecordLock(state.stateDir, () => "next")).toBe("next");
    expect(performance.now() - started).toBeLessThan(1_000);
  }, 60_000);
});
