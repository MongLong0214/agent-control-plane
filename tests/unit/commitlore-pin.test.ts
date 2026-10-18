import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMITLORE_LIMITS,
  commitloreRunner,
  createCommitLoreCliPort,
  probeCommitLore,
} from "../../src/bootstrap/commitlore-observation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Slice S16 (#246 B3) — the `commitlore` a required bootstrap runs is the one `ACP_COMMITLORE_BINARY` pins,
 * an explicit absolute path, and only once the CLI there answers a supported `--version` and has the
 * `doctor --json` command, asked in the same constructed child environment as the observation.
 *
 * Every refusal here is made with a working `commitlore` first on this process's PATH, so a producer that
 * still searched PATH would pass where these expect a refusal. Each fake is a script run by this Node from
 * a temporary directory of this run; the real CLI, when this host has one, runs under a fresh HOME.
 */

afterEach(() => vi.unstubAllEnvs());
// A check abandoned at a test's timeout never reaches that test's `finally`, which ends the child it left: a
// PID file still here names a child that was never ended, and only that exact PID is.
const hangingPidFiles: string[] = [];
const endExact = (pidFile: string): void => {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};
afterAll(() => {
  for (const pidFile of hangingPidFiles) endExact(pidFile);
  cleanupTempDirs();
});

const VARIABLE = "ACP_COMMITLORE_BINARY";
const OK_REPORT = JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] });
const FAILED_REPORT = JSON.stringify({ schema: "commitlore_doctor.v2", status: "failed", exitCode: 1, checks: [] });
const DOCTOR_USAGE = [
  "Usage: commitlore doctor [options]",
  "",
  "check that this repository can carry and share CommitLore records",
  "",
  "Options:",
  "  --fix              apply the reversible local config fixes",
  "  --json             emit the report as JSON",
  "  -h, --help         display help for command",
  "",
].join("\n");
// What the real CLI prints for `<unknown> --help`: its root usage, with exit 0.
const ROOT_USAGE = [
  "Usage: commitlore [options] [command]",
  "",
  "Git commit trailers as institutional memory for AI coding agents",
  "",
  "Options:",
  "  -V, --version   output the version number",
  "  -h, --help      display help for command",
  "",
].join("\n");

interface FakeOptions {
  version?: string;
  versionExit?: number;
  /** `--version` never answers, and writes its PID to `hanging.pid` (it ends at SIGTERM, which it does not handle). */
  versionHangs?: boolean;
  /** `--version` answers only after this many milliseconds. */
  versionDelayMs?: number;
  doctorHelp?: string;
  doctorReport?: string;
  doctorExit?: number;
  mode?: number;
}

/** A fake `commitlore` in a directory of its own; every invocation appends its argv and environment to `log`. */
const fake = (name: string, options: FakeOptions = {}): { dir: string; bin: string; log: string } => {
  const dir = tempDir(`acp-s16-${name}-`);
  const bin = join(dir, "commitlore");
  const log = join(dir, "invocations.jsonl");
  const { version = "1.7.3\n", versionExit = 0, versionHangs = false, versionDelayMs = 0, doctorHelp = DOCTOR_USAGE, doctorReport = OK_REPORT, doctorExit = 0 } = options;
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const [command, flag] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');
const answer = (text, code) => process.stdout.write(text, () => process.exit(code));
if (command === '--version') ${versionHangs ? `(fs.writeFileSync(${JSON.stringify(join(dir, "hanging.pid"))}, String(process.pid)), setInterval(() => {}, 1000))` : `setTimeout(() => answer(${JSON.stringify(version)}, ${versionExit}), ${versionDelayMs})`};
else if (command === 'doctor' && flag === '--help') answer(${JSON.stringify(doctorHelp)}, 0);
else if (command === 'doctor') answer(${JSON.stringify(`${doctorReport}\n`)}, ${doctorExit});
`,
    { mode: options.mode ?? 0o700 },
  );
  return { dir, bin, log };
};

const invocations = (log: string): Array<{ argv: string[]; env: Record<string, string> }> => {
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> });
  } catch {
    return [];
  }
};

/** A working `commitlore` first on this process's PATH: what a PATH search would find and pass with. */
const workingOnPath = () => {
  const onPath = fake("on-path");
  vi.stubEnv("PATH", `${onPath.dir}:/usr/bin:/bin`);
  return onPath;
};

const refusedWith = async (condition: string) => {
  const probed = await probeCommitLore(createCommitLoreCliPort());
  expect(probed).toMatchObject({
    allowed: false,
    evidence: {
      refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED",
      observation: { outcome: "FAIL", detail: expect.stringContaining(`${VARIABLE} ${condition}`) },
    },
  });
};

describe("S16: a pin that is not an explicit absolute path to an executable refuses required", () => {
  it("unset, or set empty, refuses NOT_CONFIGURED; no PATH search stands in for it", async () => {
    const onPath = workingOnPath();
    vi.stubEnv(VARIABLE, undefined);
    await refusedWith("NOT_CONFIGURED");
    vi.stubEnv(VARIABLE, "");
    await refusedWith("NOT_CONFIGURED");
    expect(invocations(onPath.log)).toEqual([]);
  });

  it("a bare name or a relative path refuses NOT_ABSOLUTE, even one that names a working CLI from here", async () => {
    const onPath = workingOnPath();
    const pinned = fake("relative");
    vi.stubEnv(VARIABLE, "commitlore");
    await refusedWith("NOT_ABSOLUTE");
    // Relative to this process's working directory, this path is a working CLI.
    const fromHere = relative(process.cwd(), pinned.bin);
    accessSync(fromHere, constants.X_OK);
    vi.stubEnv(VARIABLE, fromHere);
    await refusedWith("NOT_ABSOLUTE");
    vi.stubEnv(VARIABLE, `./${fromHere}`);
    await refusedWith("NOT_ABSOLUTE");
    expect([...invocations(onPath.log), ...invocations(pinned.log)]).toEqual([]);
  });

  it("an absolute path that is not there, not a file or not executable refuses with that condition", async () => {
    const onPath = workingOnPath();
    const missing = join(tempDir("acp-s16-missing-"), "commitlore");
    vi.stubEnv(VARIABLE, missing);
    await refusedWith("ABSENT");

    const directory = join(tempDir("acp-s16-directory-"), "commitlore");
    mkdirSync(directory);
    vi.stubEnv(VARIABLE, directory);
    await refusedWith("NOT_A_FILE");

    const unexecutable = fake("unexecutable", { mode: 0o600 });
    vi.stubEnv(VARIABLE, unexecutable.bin);
    await refusedWith("NOT_EXECUTABLE");
    expect([...invocations(onPath.log), ...invocations(unexecutable.log)]).toEqual([]);
  });
});

describe("S16: the pinned CLI must answer a supported version and have doctor --json before anything runs", () => {
  it.each([
    ["an older minor", { version: "1.3.17\n" }],
    ["the patch below the floor", { version: "1.4.1\n" }],
    ["another major", { version: "2.0.0\n" }],
    ["another major past the floor", { version: "2.7.3\n" }],
    ["a major below", { version: "0.9.9\n" }],
    ["a decorated version", { version: "v1.7.3\n" }],
    ["a prerelease", { version: "1.7.3-rc.1\n" }],
    ["two lines", { version: "1.7.3\n1.7.4\n" }],
    ["nothing", { version: "" }],
    ["a failing --version", { version: "1.7.3\n", versionExit: 1 }],
  ])("%s refuses UNSUPPORTED_VERSION, and no observation command runs", async (_name, options) => {
    workingOnPath();
    const pinned = fake("version", options);
    vi.stubEnv(VARIABLE, pinned.bin);
    await refusedWith("UNSUPPORTED_VERSION");
    expect(invocations(pinned.log).map(({ argv }) => argv)).toEqual([["--version"]]);
  });

  it.each([
    ["no doctor command (its root usage instead)", { doctorHelp: ROOT_USAGE }],
    ["a doctor without --json", { doctorHelp: DOCTOR_USAGE.replace(/ {2}--json[^\n]*\n/, "") }],
    ["a root usage that has a --json of its own", { doctorHelp: `${ROOT_USAGE}  --json          emit JSON\n` }],
    ["no usage at all", { doctorHelp: "" }],
  ])("%s refuses NO_DOCTOR_COMMAND, though its doctor --json would answer ok", async (_name, options) => {
    workingOnPath();
    const pinned = fake("doctor", options);
    vi.stubEnv(VARIABLE, pinned.bin);
    await refusedWith("NO_DOCTOR_COMMAND");
    expect(invocations(pinned.log).map(({ argv }) => argv)).toEqual([["--version"], ["doctor", "--help"]]);
  });

  it.each(["1.4.2\n", "1.5.1\n", "1.7.3\n", "1.10.0\n", "1.4.10\n"])("version %j within major 1 from 1.4.2 is supported", async (version) => {
    workingOnPath();
    const pinned = fake("supported", { version });
    vi.stubEnv(VARIABLE, pinned.bin);
    expect(await probeCommitLore(createCommitLoreCliPort())).toMatchObject({ allowed: true, value: { outcome: "PASS" } });
  });

  it("the pin, not PATH, is what runs: a failing CLI first on PATH does not answer for a working pin", async () => {
    const onPath = fake("failing-on-path", { doctorReport: FAILED_REPORT, doctorExit: 1 });
    vi.stubEnv("PATH", `${onPath.dir}:/usr/bin:/bin`);
    const pinned = fake("pinned");
    vi.stubEnv(VARIABLE, pinned.bin);
    expect(await probeCommitLore(createCommitLoreCliPort())).toMatchObject({ allowed: true, value: { outcome: "PASS" } });
    expect(invocations(onPath.log)).toEqual([]);
    // The pin's own checks precede the observation's first command, once.
    expect(invocations(pinned.log).map(({ argv }) => argv.join(" "))).toEqual([
      "--version",
      "doctor --help",
      "init --mcp-scope none --no-unattended",
      "doctor --json",
    ]);
  });

  it("every observation checks the pin again, before its own first command: once per observation, not once per port", async () => {
    workingOnPath();
    const pinned = fake("each-observation");
    vi.stubEnv(VARIABLE, pinned.bin);
    const port = createCommitLoreCliPort();
    const root = tempDir("acp-s16-each-observation-");
    expect(await port.observe(root)).toMatchObject({ outcome: "PASS" });
    expect(await port.observe(root)).toMatchObject({ outcome: "PASS" });
    const observation = ["--version", "doctor --help", "init --mcp-scope none --no-unattended", "doctor --json"];
    expect(invocations(pinned.log).map(({ argv }) => argv.join(" "))).toEqual([...observation, ...observation]);
  });

  it("a command's call is its spawn: the runner starts it at once, with no check inside it, and still only from an absolute pin", async () => {
    workingOnPath();
    const pinned = fake("command-only");
    const root = tempDir("acp-s16-command-only-");
    // What the S11 deadline and SIGKILL witnesses time from the call is the command alone.
    expect(await commitloreRunner(COMMITLORE_LIMITS, pinned.bin)(["doctor", "--json"], root)).toMatchObject({ exitCode: 0 });
    expect(invocations(pinned.log).map(({ argv }) => argv.join(" "))).toEqual(["doctor --json"]);
    for (const pin of [undefined, "", "commitlore", relative(process.cwd(), pinned.bin)]) {
      await expect(commitloreRunner(COMMITLORE_LIMITS, pin)(["doctor", "--json"], root)).rejects.toThrow(
        new RegExp(`${VARIABLE} (NOT_CONFIGURED|NOT_ABSOLUTE)`),
      );
    }
    expect(invocations(pinned.log)).toHaveLength(1);
  });

  it("the checks are bounded like any command: one that never answers is refused at its own bound, and nothing else runs", async () => {
    workingOnPath();
    const pinned = fake("hanging-check", { versionHangs: true });
    const pidFile = join(pinned.dir, "hanging.pid");
    hangingPidFiles.push(pidFile);
    // The first exec of a newly written executable is slow on macOS and under parallel load can outlast the
    // 800 ms bound before the fake's first statement; a second exec is not. So it is executed once, with an
    // argv that answers, before the bound starts, and that invocation is cleared from its log.
    execFileSync(pinned.bin, ["doctor", "--help"], { stdio: "ignore", timeout: 30_000 });
    writeFileSync(pinned.log, "");
    const limits = { ...COMMITLORE_LIMITS, checkTimeoutMs: 800, killGraceMs: 300 };
    try {
      const observed = await createCommitLoreCliPort(commitloreRunner(limits, pinned.bin)).observe(tempDir("acp-s16-hanging-check-"));
      expect(observed).toMatchObject({ outcome: "FAIL", detail: expect.stringMatching(/commitlore --version did not answer within 800 ms/) });
      expect(invocations(pinned.log).map(({ argv }) => argv)).toEqual([["--version"]]);
    } finally {
      endExact(pidFile);
    }
  });

  it("the checks' time is their own: a check slower than a command's bound leaves that command its whole bound", async () => {
    workingOnPath();
    // The check outlasts a command's bound, and that bound is what a command that must pass gets: wide
    // enough that a command which takes tens of milliseconds still passes when the host stalls under load.
    const pinned = fake("slow-check", { versionDelayMs: 3_500 });
    const limits = { ...COMMITLORE_LIMITS, timeoutMs: 3_000, killGraceMs: 300 };
    const observed = await createCommitLoreCliPort(commitloreRunner(limits, pinned.bin)).observe(tempDir("acp-s16-slow-check-"));
    expect(observed).toMatchObject({ outcome: "PASS" });
    expect(invocations(pinned.log).map(({ argv }) => argv.join(" "))).toEqual([
      "--version",
      "doctor --help",
      "init --mcp-scope none --no-unattended",
      "doctor --json",
    ]);
  });

  it("the checks run in the constructed child environment: no daemon authority, no unknown variable, S11-R3's credential controls", async () => {
    workingOnPath();
    const pinned = fake("environment");
    vi.stubEnv(VARIABLE, pinned.bin);
    const sentinels = ["ACP_MCP_TOKEN", "ACP_OPERATOR_TOKEN", "GH_TOKEN", "BUZZ_PRIVATE_KEY", "S16_UNKNOWN_SENTINEL"];
    for (const key of sentinels) vi.stubEnv(key, `s16-only-${key}`);
    // The daemon's HOME, and git config injected through its environment, as S11-R3's sentinels carry them.
    const daemonHome = tempDir("acp-s16-daemon-home-");
    vi.stubEnv("HOME", daemonHome);
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'credential.helper'='s16-only-parameters'");
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_1", "credential.helper");
    vi.stubEnv("GIT_CONFIG_VALUE_1", "s16-only-count");
    await probeCommitLore(createCommitLoreCliPort());
    const checks = invocations(pinned.log).filter(({ argv }) => argv[0] === "--version" || argv[1] === "--help");
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const constructed = new Set([
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_ASKPASS",
      "GIT_TERMINAL_PROMPT",
    ]);
    for (const { env } of checks) {
      expect(Object.keys(env).filter((key) => !constructed.has(key) && key !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
      expect(JSON.stringify(env)).not.toContain("s16-only-");
      expect(env["PATH"]?.split(":")).not.toContain(pinned.dir);
      // Each check is a CommitLore child like any other: a home of its own, gone once it has exited, an empty
      // global config, no system config, the helper list reset, no askpass and no prompt.
      const home = env["HOME"] as string;
      expect(home).not.toBe(daemonHome);
      expect(existsSync(home), home).toBe(false);
      expect(env).toMatchObject({
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_ASKPASS: "",
        GIT_TERMINAL_PROMPT: "0",
      });
    }
    expect(new Set(checks.map(({ env }) => env["HOME"])).size).toBe(checks.length);
  });
});

/** The host's real CLI, located for this test only (the producer never searches PATH), or null. */
const realCommitLore = (): string | null => {
  for (const directory of (process.env["PATH"] ?? "").split(":").filter((entry) => entry.startsWith("/"))) {
    try {
      accessSync(join(directory, "commitlore"), constants.X_OK);
      return join(directory, "commitlore");
    } catch {
      // not here
    }
  }
  return null;
};
const REAL = realCommitLore();

describe("S16: the real pinned CLI, in the constructed environment and a fresh HOME", () => {
  it.skipIf(REAL === null)("passes the pin's checks, writes nothing to HOME and leaves the checkout clean", async () => {
    const home = tempDir("acp-s16-real-home-");
    const repo = tempDir("acp-s16-real-repo-");
    execFileSync("git", ["init", "-q"], { cwd: repo, timeout: 20_000 });
    vi.stubEnv("HOME", home);
    vi.stubEnv(VARIABLE, undefined);
    for (const key of ["ACP_MCP_TOKEN", "ACP_OPERATOR_TOKEN", "GH_TOKEN"]) vi.stubEnv(key, `s16-only-${key}`);
    // The pin is passed, not found: its checks, `--version` and `doctor --help`, pass, and so does a run.
    const run = commitloreRunner(COMMITLORE_LIMITS, REAL as string);
    await expect(run.ready(repo)).resolves.toBeUndefined();
    const answered = await run(["--version"], repo);
    expect(answered.exitCode).toBe(0);
    expect(answered.stdout.trim()).toMatch(/^1\.\d+\.\d+$/);
    expect(readdirSync(home)).toEqual([]);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8", timeout: 20_000 });
    expect(status).toBe("");
    // The same CLI through a relative pin is refused before it runs.
    await expect(commitloreRunner(COMMITLORE_LIMITS, relative(process.cwd(), REAL as string))(["--version"], repo)).rejects.toThrow(
      new RegExp(`${VARIABLE} NOT_ABSOLUTE`),
    );
  });
});
