import { execFileSync, spawn } from "node:child_process";
import { createHash, pbkdf2 } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMITLORE_LIMITS,
  COMMITLORE_OBSERVATION_ARGV,
  commitloreRunner,
  createCommitLoreCliPort,
  probeCommitLore,
} from "../../src/bootstrap/commitlore-observation.ts";
import {
  COMMITLORE_INIT_OPTIONS,
  COMMITLORE_PIN_MAX_BYTES,
  commitlorePinIdentity,
  judgeCommitLoreVersion,
} from "../../src/bootstrap/commitlore-pin.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Slice S16 (#246 B3) — the `commitlore` a required bootstrap runs is the one `ACP_COMMITLORE_BINARY` pins,
 * an explicit absolute path, and only once the CLI there answers a canonical supported `--version`, has the
 * `doctor --json` command and has the `init` command with the options the observation passes, asked in the
 * same constructed child environment as the observation; and immediately before every later spawn of that
 * observation the pin is re-checked to be the same file those checks ran (review S16-R1-02, -03, -04). A
 * re-check is not an exec bound to those bytes: a replacement after the last re-check is not seen.
 *
 * Every refusal here is made with a working `commitlore` first on this process's PATH, so a producer that
 * still searched PATH would pass where these expect a refusal. Each fake is a script run by this Node from
 * a temporary directory of this run, answering only what a supported CLI answers: a command or option it
 * does not have is refused with exit 2, as the real CLI refuses one. The real CLI, when this host has one,
 * runs under a fresh HOME.
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

/** Counts, for a repeated run, that a witness's assertions ran: a file outside the checkout, named by that run. */
const witnessed = (line: string): void => {
  const executed = process.env["ACP_TEST_WITNESS_LOG"];
  if (executed !== undefined) appendFileSync(executed, `${line}\n`);
};

/**
 * CEO 19aabbda (C-2) — fixture preparation, done before any clock of a witness starts and bounded: the file is
 * executed once with an argv it answers at once, and its invocation cleared from its log. A preparation that
 * does not complete is a FIXTURE-PREPARATION FAILURE, never a pass. A witness prepared this way measures a
 * child whose file was already executed once, and is no evidence about a cold first spawn (that witness is
 * "a newly written pin's first spawn" below, unprepared, under the production bounds).
 */
const PREPARATION_TIMEOUT_MS = 30_000;
const prepareFixture = (bin: string, argv: readonly string[], log: string): void => {
  try {
    execFileSync(bin, [...argv], { stdio: "ignore", timeout: PREPARATION_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`FIXTURE-PREPARATION FAILURE: ${bin} ${argv.join(" ")} did not complete within ${PREPARATION_TIMEOUT_MS} ms (${(error as Error).message.split("\n", 1)[0]}); the witness was not judged`);
  }
  writeFileSync(log, "");
};

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
// What the real CLI 1.7.3 prints for `init --help`, its options in the order it lists them.
const INIT_USAGE = [
  "Usage: commitlore init [options]",
  "",
  "one-command onboarding: hooks install, directive author string, index --rebuild,",
  "agent integration, MCP registration, capture policy, doctor --fix",
  "",
  "Options:",
  "  --mcp-scope <scope>  where to register the capture server: user, project,",
  "                       local, none (skips the prompt; default user)",
  "  --force              forward to hooks install — replace an already-preserved",
  "                       foreign hook",
  "  --json               emit the report as JSON",
  "  --unattended         enable unattended capture if the repository has no policy",
  "                       file yet (skips the prompt; for scripts)",
  "  --no-unattended      leave unattended capture off if the repository has no",
  "                       policy file yet (skips the prompt; for scripts)",
  "  -h, --help           display help for command",
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
const OBSERVATION = ["--version", "doctor --help", "init --help", "init --mcp-scope none --no-unattended", "doctor --json"];

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
  /** Whether the CLI has `init`; without it `init --help` is its root usage (exit 0) and `init` is unknown. */
  hasInit?: boolean;
  initHelp?: string;
  initHelpExit?: number;
  initExit?: number;
  /** What an argv it does not have gets: refused with exit 2 (the real CLI), or its root usage with exit 0. */
  unknown?: "refuse" | "root-usage";
  /** JavaScript run first, before answering, by the invocation whose argv joined by spaces is `argv`. */
  during?: { argv: string; code: string };
  mode?: number;
}

/** A fake `commitlore` in a directory of its own; every invocation appends its argv and environment to `log`. */
const fake = (name: string, options: FakeOptions = {}): { dir: string; bin: string; log: string } => {
  const dir = tempDir(`acp-s16-${name}-`);
  const bin = join(dir, "commitlore");
  const log = join(dir, "invocations.jsonl");
  const {
    version = "1.7.3\n",
    versionExit = 0,
    versionHangs = false,
    versionDelayMs = 0,
    doctorHelp = DOCTOR_USAGE,
    doctorReport = OK_REPORT,
    doctorExit = 0,
    hasInit = true,
    initHelp = INIT_USAGE,
    initHelpExit = 0,
    initExit = 0,
    unknown = "refuse",
    during,
  } = options;
  const unknownAnswer =
    unknown === "root-usage" ? `answer(${JSON.stringify(ROOT_USAGE)}, 0)` : `process.stderr.write("error: unknown command or option '" + argv.join(' ') + "'\\n", () => process.exit(2))`;
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const [command, flag] = argv;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env: process.env, origin: performance.timeOrigin, first: performance.timeOrigin + performance.now() }) + '\\n');
const answer = (text, code) => process.stdout.write(text, () => process.exit(code));
${during === undefined ? "" : `if (argv.join(' ') === ${JSON.stringify(during.argv)}) { ${during.code} }`}
if (command === '--version' && argv.length === 1) ${versionHangs ? `(fs.writeFileSync(${JSON.stringify(join(dir, "hanging.pid"))}, String(process.pid)), setInterval(() => {}, 1000))` : `setTimeout(() => answer(${JSON.stringify(version)}, ${versionExit}), ${versionDelayMs})`};
else if (command === 'doctor' && flag === '--help' && argv.length === 2) answer(${JSON.stringify(doctorHelp)}, 0);
else if (command === 'doctor' && flag === '--json' && argv.length === 2) answer(${JSON.stringify(`${doctorReport}\n`)}, ${doctorExit});
else if (command === 'init' && flag === '--help' && argv.length === 2) ${hasInit ? `answer(${JSON.stringify(initHelp)}, ${initHelpExit})` : `answer(${JSON.stringify(ROOT_USAGE)}, 0)`};
else if (${hasInit} && argv.join(' ') === 'init --mcp-scope none --no-unattended') answer('', ${initExit});
else ${unknownAnswer};
`,
    { mode: options.mode ?? 0o700 },
  );
  return { dir, bin, log };
};

const invocations = (log: string): Array<{ argv: string[]; env: Record<string, string>; origin: number; first: number }> => {
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string>; origin: number; first: number });
  } catch {
    return [];
  }
};
const argvs = (log: string): string[] => invocations(log).map(({ argv }) => argv.join(" "));

/** A working `commitlore` first on this process's PATH: what a PATH search would find and pass with. */
const workingOnPath = () => {
  const onPath = fake("on-path");
  vi.stubEnv("PATH", `${onPath.dir}:/usr/bin:/bin`);
  return onPath;
};

const refusedWith = async (condition: string, port = createCommitLoreCliPort()) => {
  const probed = await probeCommitLore(port);
  expect(probed).toMatchObject({
    allowed: false,
    evidence: {
      refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED",
      observation: { outcome: "FAIL", detail: expect.stringContaining(`${VARIABLE} ${condition}`) },
    },
  });
  return probed;
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
    // Review S16-R1-04: a numeral that is not canonical is refused before any range is judged.
    ["a leading-zero major (01.7.3)", { version: "01.7.3\n" }],
    ["leading-zero minor and patch (1.04.02)", { version: "1.04.02\n" }],
    ["a leading-zero patch (1.7.03)", { version: "1.7.03\n" }],
    ["a signed component (+1.7.3)", { version: "+1.7.3\n" }],
    ["four components (1.7.3.0)", { version: "1.7.3.0\n" }],
    ["digits outside ASCII (١.٧.٣)", { version: "١.٧.٣\n" }],
  ])("%s refuses UNSUPPORTED_VERSION, and no observation command runs", async (_name, options) => {
    workingOnPath();
    const pinned = fake("version", options);
    vi.stubEnv(VARIABLE, pinned.bin);
    await refusedWith("UNSUPPORTED_VERSION");
    expect(argvs(pinned.log)).toEqual(["--version"]);
  });

  it("the range is judged on the parsed numbers, exactly at any length, and never on the text", () => {
    const answer = (stdout: string) => judgeCommitLoreVersion("/pinned/commitlore", { exitCode: 0, stdout, stderr: "" });
    // Text order would put "1.10.0" and "1.4.10" below "1.4.2"; numbers put them above.
    for (const version of ["1.4.2", "1.4.10", "1.10.0", `1.4.${"9".repeat(400)}`, ` 1.7.3 \n`]) expect(answer(version), version).toBeNull();
    // A number past what a double holds exactly is still compared exactly: below the floor is below it.
    for (const version of ["1.4.1", `1.3.${"9".repeat(400)}`, `${"1".repeat(400)}.4.2`, "01.7.3", "1.04.02"]) {
      expect(answer(version), version).toMatch(/UNSUPPORTED_VERSION: .* supported is a canonical MAJOR\.MINOR\.PATCH, 1\.x from 1\.4\.2$/);
    }
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
    expect(argvs(pinned.log)).toEqual(["--version", "doctor --help"]);
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
    expect(argvs(pinned.log)).toEqual(OBSERVATION);
  });

  it("every observation checks the pin again, before its own first command: once per observation, not once per port", async () => {
    workingOnPath();
    const pinned = fake("each-observation");
    vi.stubEnv(VARIABLE, pinned.bin);
    const port = createCommitLoreCliPort();
    const root = tempDir("acp-s16-each-observation-");
    expect(await port.observe(root)).toMatchObject({ outcome: "PASS" });
    expect(await port.observe(root)).toMatchObject({ outcome: "PASS" });
    expect(argvs(pinned.log)).toEqual([...OBSERVATION, ...OBSERVATION]);
  });

  it("a command's call is its spawn: the runner starts it at once, with no check inside it, and still only from an absolute pin", async () => {
    workingOnPath();
    const pinned = fake("command-only");
    const root = tempDir("acp-s16-command-only-");
    // What the S11 deadline and SIGKILL witnesses time from the call is the command alone.
    expect(await commitloreRunner(COMMITLORE_LIMITS, pinned.bin)(["doctor", "--json"], root)).toMatchObject({ exitCode: 0 });
    expect(argvs(pinned.log)).toEqual(["doctor --json"]);
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
    // Prepared before the 800 ms bound starts (`prepareFixture`), with an argv that answers.
    prepareFixture(pinned.bin, ["doctor", "--help"], pinned.log);
    const limits = { ...COMMITLORE_LIMITS, checkTimeoutMs: 800, killGraceMs: 300 };
    try {
      const observed = await createCommitLoreCliPort(commitloreRunner(limits, pinned.bin)).observe(tempDir("acp-s16-hanging-check-"));
      expect(observed).toMatchObject({ outcome: "FAIL", detail: expect.stringMatching(/commitlore --version did not answer within 800 ms/) });
      expect(argvs(pinned.log)).toEqual(["--version"]);
    } finally {
      endExact(pidFile);
    }
  });

  it("the checks' time is their own: a check slower than a command's bound leaves that command its whole bound", async () => {
    workingOnPath();
    // The original budget (CEO 19aabbda C-3): a 1 s bound for each command, after a 1.5 s check. Each child
    // is the shell fake below. Reproduced under load with the node fake, the failure was that fake's own
    // start-up inside `init`'s 1 s, timed from `init`'s own spawn, and never time the checks took from it
    // (s16-r1-fix-evidence/c3-cause-head-*).
    const pinned = shellFake("slow-check", { versionDelay: "1.5" });
    const limits = { ...COMMITLORE_LIMITS, timeoutMs: 1_000, killGraceMs: 300 };
    const started = performance.now();
    const observed = await createCommitLoreCliPort(commitloreRunner(limits, pinned.bin)).observe(tempDir("acp-s16-slow-check-"));
    const elapsed = performance.now() - started;
    const trace = process.env["S16_WITNESS_TRACE"];
    if (trace !== undefined) appendFileSync(trace, `${JSON.stringify({ elapsed, observed, ran: shellArgvs(pinned.log) })}\n`);
    expect(observed).toMatchObject({ outcome: "PASS" });
    // The check really was slower than a command's whole bound, and both commands still ran after it.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(shellArgvs(pinned.log)).toEqual(OBSERVATION);
    witnessed(`S16 checks-time-own asserted elapsed=${Math.round(elapsed)}`);
  });

  it("a newly written pin's first spawn is cold, and it is its first check, under the production bounds: it passes, and no command pays for it", async () => {
    workingOnPath();
    // Not prepared: this file has never been executed, as after an install or an upgrade (CEO 19aabbda C-2).
    const pinned = fake("cold-first-spawn");
    expect(COMMITLORE_LIMITS).toMatchObject({ checkTimeoutMs: 180_000, timeoutMs: 180_000 });
    const started = performance.timeOrigin + performance.now();
    const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, pinned.bin)).observe(tempDir("acp-s16-cold-"));
    expect(observed).toMatchObject({ outcome: "PASS" });
    const ran = invocations(pinned.log);
    // Its first exec, which pays the cold cost, is the `--version` check, under `checkTimeoutMs`; `init` and
    // `doctor` are its fourth and fifth.
    expect(ran.map(({ argv }) => argv.join(" "))).toEqual(OBSERVATION);
    witnessed(`S16 cold-first-spawn asserted firstStatementMs=${Math.round((ran[0]?.first ?? Number.NaN) - started)}`);
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
    expect(checks.map(({ argv }) => argv.join(" "))).toEqual(["--version", "doctor --help", "init --help"]);
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

describe("S16-R1-03: the pinned CLI must have the init command, with the options the observation passes, before init runs", () => {
  it("the options checked are the options the observation passes to init", () => {
    expect(COMMITLORE_INIT_OPTIONS).toEqual(COMMITLORE_OBSERVATION_ARGV[0]?.filter((part) => part.startsWith("--")));
  });

  it.each([
    ["no init command (its root usage for init --help, and init itself unknown)", { hasInit: false }],
    ["no init command, and every unknown command answered with its root usage and exit 0", { hasInit: false, unknown: "root-usage" as const }],
    ["an init without --mcp-scope", { initHelp: INIT_USAGE.replace(/ {2}--mcp-scope[^\n]*\n[^\n]*\n/, "") }],
    ["an init without --no-unattended", { initHelp: INIT_USAGE.replace(/ {2}--no-unattended[^\n]*\n[^\n]*\n/, "") }],
    ["an init usage that names the options only in prose", { initHelp: "Usage: commitlore init [options]\n\nPass --mcp-scope none and --no-unattended from scripts.\n" }],
    ["no usage at all", { initHelp: "" }],
    ["a failing init --help", { initHelpExit: 1 }],
  ])("%s refuses NO_INIT_COMMAND, and init never runs", async (_name, options) => {
    workingOnPath();
    const pinned = fake("init", options);
    vi.stubEnv(VARIABLE, pinned.bin);
    await refusedWith("NO_INIT_COMMAND");
    expect(argvs(pinned.log)).toEqual(["--version", "doctor --help", "init --help"]);
  });

  it("the reviewer's witness: a CLI with version and doctor support that answers root usage, exit 0, for a missing init is refused", async () => {
    workingOnPath();
    // Every argv but `--version`, `doctor --help` and `doctor --json` gets its root usage with exit 0.
    const pinned = fake("no-init-root-usage", { hasInit: false, unknown: "root-usage" });
    expect(execFileSync(pinned.bin, ["init", "--mcp-scope", "none", "--no-unattended"], { encoding: "utf8", timeout: 30_000 })).toBe(ROOT_USAGE);
    writeFileSync(pinned.log, "");
    const probed = await refusedWith("NO_INIT_COMMAND", createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, pinned.bin)));
    expect(probed.allowed).toBe(false);
    expect(argvs(pinned.log)).not.toContain("init --mcp-scope none --no-unattended");
  });

  it("the help check runs no init and vouches for none: an init that lists its options and then fails still fails the observation", async () => {
    workingOnPath();
    const pinned = fake("init-fails", { initExit: 2 });
    const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, pinned.bin)).observe(tempDir("acp-s16-init-fails-"));
    expect(observed).toMatchObject({ outcome: "FAIL", detail: expect.stringMatching(/^commitlore init failed \(2\)/) });
    expect(argvs(pinned.log)).toEqual(OBSERVATION.slice(0, 4));
  });
});

describe("S16-R1-02: every spawn after the checks is preceded by a re-check that the pin is still the file the checks ran", () => {
  /** A CLI that would pass everything but `--version`, logging every argv that reaches it. */
  const uncheckedTarget = () => fake("unchecked-target", { version: "2.0.0\n" });
  const observeAt = (pin: string) => probeCommitLore(createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, pin)));
  const swapLink = (pin: string, to: string) =>
    `fs.symlinkSync(${JSON.stringify(to)}, ${JSON.stringify(`${pin}.next`)}); fs.renameSync(${JSON.stringify(`${pin}.next`)}, ${JSON.stringify(pin)});`;
  const renameOver = (pin: string, from: string) =>
    `fs.copyFileSync(${JSON.stringify(from)}, ${JSON.stringify(`${pin}.next`)}); fs.chmodSync(${JSON.stringify(`${pin}.next`)}, 0o700); fs.renameSync(${JSON.stringify(`${pin}.next`)}, ${JSON.stringify(pin)});`;
  const rewrite = (pin: string, from: string) => `fs.writeFileSync(${JSON.stringify(pin)}, fs.readFileSync(${JSON.stringify(from)}));`;
  const touch = (pin: string) => `fs.utimesSync(${JSON.stringify(pin)}, new Date(), new Date(Date.now() + 5000));`;

  it("the reviewer's symlink witness: a pin link swapped to another file during doctor --help is refused, and the other file runs nothing", async () => {
    workingOnPath();
    const bad = uncheckedTarget();
    const pin = join(tempDir("acp-s16-swap-"), "commitlore");
    const good = fake("checked-target", { during: { argv: "doctor --help", code: swapLink(pin, bad.bin) } });
    symlinkSync(good.bin, pin);
    const probed = await observeAt(pin);
    expect(probed).toMatchObject({ allowed: false, evidence: { observation: { outcome: "FAIL", detail: expect.stringContaining(`${VARIABLE} REPLACED`) } } });
    expect(argvs(bad.log)).toEqual([]);
    expect(argvs(good.log)).toEqual(["--version", "doctor --help"]);
    witnessed("S16-R1-02 symlink-swap asserted");
  });

  it("the reviewer's rename witness: a regular pin renamed over by different bytes during doctor --help is refused, and those bytes run nothing", async () => {
    workingOnPath();
    const bad = uncheckedTarget();
    const good = fake("renamed-over", {});
    const pin = good.bin;
    writeFileSync(pin, readFileSync(pin, "utf8").replace("const answer =", `if (argv.join(' ') === 'doctor --help') { ${renameOver(pin, bad.bin)} }\nconst answer =`), { mode: 0o700 });
    const probed = await observeAt(pin);
    expect(probed).toMatchObject({ allowed: false, evidence: { observation: { outcome: "FAIL", detail: expect.stringContaining(`${VARIABLE} REPLACED`) } } });
    expect(argvs(bad.log)).toEqual([]);
    expect(argvs(good.log)).toEqual(["--version", "doctor --help"]);
    witnessed("S16-R1-02 rename-over asserted");
  });

  it.each([
    ["rewritten in place with other bytes", "rewrite", "doctor --help"],
    ["only its modification time changed", "touch", "doctor --help"],
    ["its link swapped between the first and second checks", "link", "--version"],
    ["its link swapped during the last check", "link", "init --help"],
  ] as const)("a pin %s is refused as REPLACED, and nothing after that check spawns", async (_name, how, when) => {
    workingOnPath();
    const bad = uncheckedTarget();
    const linked = how === "link";
    const pin = linked ? join(tempDir("acp-s16-link-"), "commitlore") : "";
    const good = fake("changed", {});
    const target = linked ? pin : good.bin;
    const code = how === "rewrite" ? rewrite(target, bad.bin) : how === "touch" ? touch(target) : swapLink(target, bad.bin);
    writeFileSync(good.bin, readFileSync(good.bin, "utf8").replace("const answer =", `if (argv.join(' ') === ${JSON.stringify(when)}) { ${code} }\nconst answer =`), { mode: 0o700 });
    if (linked) symlinkSync(good.bin, pin);
    const probed = await observeAt(target);
    expect(probed).toMatchObject({ allowed: false, evidence: { observation: { outcome: "FAIL", detail: expect.stringContaining(`${VARIABLE} REPLACED`) } } });
    expect(argvs(bad.log)).toEqual([]);
    const checks = ["--version", "doctor --help", "init --help"];
    expect(argvs(good.log)).toEqual(checks.slice(0, checks.indexOf(when) + 1));
  });

  it("a pin replaced while init runs: doctor is refused before it spawns, and the replacement runs nothing", async () => {
    workingOnPath();
    const bad = uncheckedTarget();
    const pin = join(tempDir("acp-s16-during-init-"), "commitlore");
    const good = fake("during-init", { during: { argv: "init --mcp-scope none --no-unattended", code: swapLink(pin, bad.bin) } });
    symlinkSync(good.bin, pin);
    const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, pin)).observe(tempDir("acp-s16-during-init-checkout-"));
    expect(observed).toMatchObject({ outcome: "FAIL", detail: expect.stringMatching(new RegExp(`^commitlore doctor could not be run: ${VARIABLE} REPLACED`)) });
    expect(argvs(bad.log)).toEqual([]);
    expect(argvs(good.log)).toEqual(OBSERVATION.slice(0, 4));
  });

  it("an unchanged pin, a link included, passes: the identity is read again before each spawn and still matches", async () => {
    workingOnPath();
    const good = fake("unchanged-link", {});
    const pin = join(tempDir("acp-s16-unchanged-"), "commitlore");
    symlinkSync(good.bin, pin);
    expect(await observeAt(pin)).toMatchObject({ allowed: true, value: { outcome: "PASS" } });
    expect(argvs(good.log)).toEqual(OBSERVATION);
  });
});

/**
 * A `commitlore` that is a `/bin/sh` script: what it answers is fixed when it is written, before any clock
 * starts, so a command it answers costs a shell's start and a `printf`, not an interpreter's start-up. The
 * `--version` check sleeps `versionDelay` seconds first. Each invocation appends its argv to `log`.
 */
const shellFake = (name: string, { versionDelay = "0" }: { versionDelay?: string } = {}): { dir: string; bin: string; log: string } => {
  const dir = tempDir(`acp-s16-${name}-`);
  const bin = join(dir, "commitlore");
  const log = join(dir, "invocations.txt");
  const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${quoted(log)}`,
      'case "$*" in',
      `  "--version") sleep ${versionDelay}; printf '1.7.3\\n' ;;`,
      `  "doctor --help") printf '%s' ${quoted(DOCTOR_USAGE)} ;;`,
      `  "init --help") printf '%s' ${quoted(INIT_USAGE)} ;;`,
      `  "init --mcp-scope none --no-unattended") : ;;`,
      `  "doctor --json") printf '%s\\n' ${quoted(OK_REPORT)} ;;`,
      `  *) printf "error: unknown command or option '%s'\\n" "$*" >&2; exit 2 ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { dir, bin, log };
};
const shellArgvs = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

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
    // The pin is passed, not found: its checks, `--version`, `doctor --help` and `init --help`, pass, and so
    // does a run through the runner they bound.
    const run = commitloreRunner(COMMITLORE_LIMITS, REAL as string);
    const checked = await run.ready(repo);
    const answered = await checked(["--version"], repo);
    expect(answered.exitCode).toBe(0);
    expect(answered.stdout.trim()).toMatch(/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(readdirSync(home)).toEqual([]);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8", timeout: 20_000 });
    expect(status).toBe("");
    // The same CLI through a relative pin is refused before it runs.
    await expect(commitloreRunner(COMMITLORE_LIMITS, relative(process.cwd(), REAL as string))(["--version"], repo)).rejects.toThrow(
      new RegExp(`${VARIABLE} NOT_ABSOLUTE`),
    );
  });
});

/**
 * Review S16-R2-01 (CEO 37d29a30) — reading which file a pin is is bounded and never stalls the event loop:
 * on the descriptor opened without following a link, a regular file of at most `COMMITLORE_PIN_MAX_BYTES`
 * before any byte is read; at most its size plus one byte read; its own deadline; growth or change refused;
 * the descriptor closed on every path. Every file here that is large in its apparent size is sparse: no
 * test allocates its size. A witness whose child had to be killed by its watchdog has failed.
 */
describe("S16-R2-01: reading the pin's identity is bounded, has its own deadline and lets the event loop turn", () => {
  const CAP = 8 * 1024 * 1024;
  const TIB = 2 ** 40;
  /** `path` extended to `bytes` without writing them: the file system allocates nothing for the hole. */
  const sparse = (path: string, bytes: number): void => {
    const descriptor = openSync(path, "r+");
    try {
      ftruncateSync(descriptor, bytes);
    } finally {
      closeSync(descriptor);
    }
  };
  /**
   * What happened while `work` ran: how many turns the event loop made (an immediate re-armed each turn), how
   * often a 1 ms timer heartbeat fired, and how it settled. A reading that blocks the loop makes no turn.
   */
  const duringCheck = async <T>(work: () => T | Promise<T>) => {
    let turns = 0;
    let beats = 0;
    let running = true;
    const turn = (): void => {
      if (!running) return;
      turns += 1;
      setImmediate(turn);
    };
    setImmediate(turn);
    const heartbeat = setInterval(() => (beats += 1), 1);
    const started = performance.now();
    try {
      const value = await Promise.resolve().then(work);
      return { value, error: null, turns, beats, elapsed: performance.now() - started };
    } catch (error) {
      return { value: null, error: (error as Error).message, turns, beats, elapsed: performance.now() - started };
    } finally {
      running = false;
      clearInterval(heartbeat);
    }
  };
  /** The descriptors of this process that refer to `path`'s file, found through /dev/fd. */
  const descriptorsOn = (path: string): number[] => {
    const { dev, ino } = statSync(path);
    return readdirSync("/dev/fd")
      .map(Number)
      .filter((fd) => {
        try {
          const opened = fstatSync(fd);
          return opened.dev === dev && opened.ino === ino;
        } catch {
          return false;
        }
      });
  };
  /** Every worker of libuv's pool kept busy for longer than any deadline below, by key derivations. */
  const occupyPool = (): Promise<unknown[]> => {
    const workers = Number(process.env["UV_THREADPOOL_SIZE"] ?? 4);
    return Promise.all(Array.from({ length: workers }, () => new Promise((settled) => pbkdf2("s16", "r2", 4_000_000, 32, "sha256", settled))));
  };

  /**
   * The reviewer's harness (s16-r2-evidence/hash-budget-*.ts|mjs), its paths aside: a Node child observes
   * through the production port with `timeoutMs` 100 and the given `checkTimeoutMs`, logging a 25 ms
   * heartbeat, the moment the call returned its promise and the answer; added here, the turns the event loop
   * made before the answer. The parent kills it by its own handle at `watchdogMs`, and that is a failure.
   */
  const OBSERVATION_MODULE = new URL("../../src/bootstrap/commitlore-observation.ts", import.meta.url).href;
  const HARNESS = `import { appendFileSync } from "node:fs";
const [moduleUrl, pin, log, checkTimeoutMs, checkout] = process.argv.slice(2);
const write = (event) => appendFileSync(log, JSON.stringify(event) + "\\n");
const { COMMITLORE_LIMITS, commitloreRunner, createCommitLoreCliPort } = await import(moduleUrl);
write({ event: "loaded" });
const start = performance.now();
const heartbeat = setInterval(() => write({ event: "heartbeat", elapsed: performance.now() - start }), 25);
let turns = 0;
let observing = true;
const turn = () => { if (!observing) return; turns += 1; setImmediate(turn); };
const limits = { ...COMMITLORE_LIMITS, checkTimeoutMs: Number(checkTimeoutMs), timeoutMs: 100 };
write({ event: "observe-call", checkTimeoutMs: limits.checkTimeoutMs, timeoutMs: limits.timeoutMs });
setImmediate(turn);
const pending = createCommitLoreCliPort(commitloreRunner(limits, pin)).observe(checkout);
write({ event: "observe-returned-promise", elapsed: performance.now() - start });
const result = await pending;
observing = false;
write({ event: "answer", elapsed: performance.now() - start, turns, result });
setTimeout(() => { clearInterval(heartbeat); write({ event: "done", elapsed: performance.now() - start }); }, 80);
`;
  interface HarnessEvent {
    event: string;
    elapsed?: number;
    turns?: number;
    result?: { outcome: string; detail: string };
  }
  const observeInChild = (pin: string, checkTimeoutMs: number, watchdogMs: number) =>
    new Promise<{ watchdog: boolean; code: number | null; signal: string | null; stderr: string; events: HarnessEvent[] }>((resolve) => {
      const dir = tempDir("acp-s16-r2-harness-");
      const script = join(dir, "harness.mjs");
      const log = join(dir, "events.jsonl");
      writeFileSync(script, HARNESS);
      writeFileSync(log, "");
      const child = spawn(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", script, OBSERVATION_MODULE, pin, log, String(checkTimeoutMs), tempDir("acp-s16-r2-checkout-")],
        { cwd: dir, env: { ...process.env, HOME: tempDir("acp-s16-r2-home-") }, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      let watchdog = false;
      const timer = setTimeout(() => {
        watchdog = true;
        child.kill("SIGKILL");
      }, watchdogMs);
      const done = (code: number | null, signal: string | null): void => {
        clearTimeout(timer);
        const events = readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as HarnessEvent);
        resolve({ watchdog, code, signal, stderr: stderr.slice(-2000), events });
      };
      child.once("error", (error) => done(null, `spawn error: ${error.message}`));
      child.once("close", done);
    });
  const judgedInChild = (run: Awaited<ReturnType<typeof observeInChild>>) => {
    expect({ watchdog: run.watchdog, code: run.code, signal: run.signal, stderr: run.stderr }).toEqual({ watchdog: false, code: 0, signal: null, stderr: "" });
    const names = run.events.map(({ event }) => event);
    // The call returned its promise before anything was answered: nothing ran to completion inside it.
    expect(names.indexOf("observe-returned-promise")).toBeGreaterThan(-1);
    expect(names.indexOf("observe-returned-promise")).toBeLessThan(names.indexOf("answer"));
    const answer = run.events.find(({ event }) => event === "answer") as HarnessEvent;
    // The event loop turned while the observation was pending, and the heartbeat kept firing.
    expect(answer.turns).toBeGreaterThan(0);
    expect(names.filter((name) => name === "heartbeat").length).toBeGreaterThan(0);
    return answer;
  };

  it("the reviewer's sparse-file witness: a 1-TiB executable pin under 100 ms bounds is refused TOO_LARGE at once, runs nothing, and the heartbeat fires", async () => {
    const dir = tempDir("acp-s16-r2-sparse-");
    const pin = join(dir, "commitlore");
    const ran = join(dir, "ran.txt");
    // The reviewer's script (hash-budget-parent.mjs), logging each argv that reaches it, then made 1 TiB.
    writeFileSync(
      pin,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ran}'\ncase "$*" in\n"--version") echo 1.7.3; exit 0;;\n"doctor --help") printf "Usage: commitlore doctor [options]\\n  --json\\n"; exit 0;;\n"init --help") printf "Usage: commitlore init [options]\\n  --mcp-scope <scope>\\n  --no-unattended\\n"; exit 0;;\n"init --mcp-scope none --no-unattended") exit 0;;\n"doctor --json") echo '${OK_REPORT}'; exit 0;;\nesac\nexit 2\n`,
      { mode: 0o700 },
    );
    sparse(pin, TIB);
    try {
      const run = await observeInChild(pin, 100, 2_500);
      const answer = judgedInChild(run);
      expect(answer.result).toMatchObject({
        outcome: "FAIL",
        detail: expect.stringMatching(new RegExp(`^commitlore could not be run: ${VARIABLE} TOO_LARGE: .* is ${TIB} bytes, more than the ${CAP} bytes`)),
      });
      expect(answer.elapsed).toBeLessThan(1_000);
      expect(existsSync(ran)).toBe(false);
      witnessed(`S16-R2-01 sparse asserted answerMs=${Math.round(answer.elapsed ?? Number.NaN)} turns=${answer.turns}`);
    } finally {
      rmSync(pin, { force: true });
    }
  });

  it("growth during the check: a pin that makes itself 1 TiB (sparse) during doctor --help is refused before init --help spawns, at once, while the heartbeat fires", async () => {
    // The reviewer's growth case, its paths aside: the CLI the pin is grows its own file during a check.
    const pinned = fake("grow-during-check", { during: { argv: "doctor --help", code: `fs.truncateSync(process.argv[1], ${TIB});` } });
    // Bounded preparation before the watchdog starts (`prepareFixture`): the new file's cold first exec.
    prepareFixture(pinned.bin, ["--version"], pinned.log);
    try {
      const run = await observeInChild(pinned.bin, 5_000, 5_000);
      const answer = judgedInChild(run);
      // The re-check reads the pin's realpath, the path the refusal names inside its parentheses: a runner's
      // /var/folders tmp dir is /private/var/folders. The observation keeps a refusal's first 300 characters
      // (commitlore-observation.ts); under that longer tmp path the cap's wording falls past them, the code,
      // both paths and the size do not.
      const target = realpathSync(pinned.bin);
      const refusal = `${VARIABLE} REPLACED: ${pinned.bin} can no longer be read as the file its checks ran (${target} is ${TIB} bytes, more than the ${CAP} bytes a supported entrypoint is)`;
      expect(answer.result).toMatchObject({ outcome: "FAIL", detail: `commitlore could not be run: ${refusal.slice(0, 300)}` });
      expect(answer.result?.detail).toContain(`(${target} is ${TIB} bytes`);
      expect(statSync(pinned.bin).size).toBe(TIB);
      // It grew during doctor --help, and nothing spawned after that check.
      expect(argvs(pinned.log)).toEqual(["--version", "doctor --help"]);
      witnessed(`S16-R2-01 grow-during-check asserted answerMs=${Math.round(answer.elapsed ?? Number.NaN)} turns=${answer.turns}`);
    } finally {
      rmSync(pinned.bin, { force: true });
    }
  });

  it("growth while the identity is read: a pin that grows at every turn of the event loop during the read is refused, never bound", async () => {
    const pin = join(tempDir("acp-s16-r2-growing-"), "commitlore");
    writeFileSync(pin, "#!/bin/sh\n", { mode: 0o700 });
    sparse(pin, 4 * 1024 * 1024);
    let growing = true;
    let grew = 0;
    const grow = (): void => {
      if (!growing) return;
      appendFileSync(pin, "#");
      grew += 1;
      setImmediate(grow);
    };
    setImmediate(grow);
    const read = await duringCheck(() => commitlorePinIdentity(pin));
    growing = false;
    expect(read).toMatchObject({ value: null, error: expect.stringMatching(/changed while it was read/) });
    expect(grew).toBeGreaterThan(0);
    witnessed(`S16-R2-01 grow-while-read asserted grew=${grew} turns=${read.turns}`);
  });

  it("the cap is checked on the descriptor before a byte is read: a sparse pin of exactly the cap is read whole while the loop turns, one byte more is refused TOO_LARGE", async () => {
    const dir = tempDir("acp-s16-r2-cap-");
    const atCap = join(dir, "at-cap");
    const overCap = join(dir, "over-cap");
    for (const path of [atCap, overCap]) writeFileSync(path, "#!/bin/sh\n", { mode: 0o700 });
    sparse(atCap, CAP);
    sparse(overCap, CAP + 1);
    const read = await duringCheck(() => commitlorePinIdentity(atCap));
    // Read in 64 KiB chunks, one turn of the event loop each: 128 of them for the cap.
    expect(read.turns).toBeGreaterThanOrEqual(64);
    expect(read.value).toMatchObject({ size: String(CAP), sha256: createHash("sha256").update(readFileSync(atCap)).digest("hex") });
    const over = await duringCheck(() => commitlorePinIdentity(overCap));
    // The refusal names the file it opened, the pin's realpath: a runner's /var/folders tmp dir is /private/var/folders.
    expect(over.error).toBe(`${realpathSync(overCap)} is ${CAP + 1} bytes, more than the ${CAP} bytes a supported entrypoint is`);
    expect(COMMITLORE_PIN_MAX_BYTES).toBe(CAP);
    witnessed(`S16-R2-01 cap asserted turns=${read.turns} beats=${read.beats} ms=${read.elapsed.toFixed(1)}`);
  });

  it("the identity check has its own deadline: with the file system's workers busy, it is refused at that deadline while the heartbeat fires, its descriptor is closed, and the observation runs nothing", async () => {
    const pinned = fake("identity-deadline");
    const pool = occupyPool();
    const read = await duringCheck(() => commitlorePinIdentity(pinned.bin, 100));
    await pool;
    expect(read.error).toBe(`${pinned.bin} could not be read within 100 ms`);
    expect(read.elapsed).toBeGreaterThanOrEqual(99);
    expect(read.elapsed).toBeLessThan(1_000);
    // A 1 ms heartbeat kept firing for the whole wait.
    expect(read.beats).toBeGreaterThanOrEqual(20);
    // Whatever the abandoned reading opened once the pool freed up, it closed.
    await vi.waitFor(() => expect(descriptorsOn(pinned.bin)).toEqual([]), { timeout: 2_000, interval: 20 });
    // Through the runner: `identityTimeoutMs` is that deadline, and the refusal comes before any spawn.
    const busy = occupyPool();
    const observed = await createCommitLoreCliPort(commitloreRunner({ ...COMMITLORE_LIMITS, identityTimeoutMs: 100 }, pinned.bin)).observe(
      tempDir("acp-s16-r2-deadline-checkout-"),
    );
    await busy;
    expect(observed).toMatchObject({
      outcome: "FAIL",
      detail: `commitlore could not be run: ${VARIABLE} UNREADABLE: ${pinned.bin} could not be read as a file to check (${pinned.bin} could not be read within 100 ms)`,
    });
    expect(argvs(pinned.log)).toEqual([]);
    witnessed(`S16-R2-01 identity-deadline asserted beats=${read.beats} ms=${read.elapsed.toFixed(1)}`);
  });

  it("normal-entrypoint control: the installer's wrapper and a bundle-sized script pinned directly are read while the loop turns, and pass under the production bounds", async () => {
    // The installer's wrapper (`commitlore:wrapper:v1`), exec'ing Node on a bundle, as install.sh writes it.
    const bundle = fake("control-bundle");
    const wrapper = join(tempDir("acp-s16-r2-wrapper-"), "commitlore");
    writeFileSync(
      wrapper,
      `#!/bin/sh\n# commitlore:wrapper:v1\n# Installed by install.sh. Edits are lost on reinstall.\nNODE="${process.execPath}"\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" "${bundle.bin}" "$@"\n`,
      { mode: 0o700 },
    );
    // The release bundle pinned directly, at the size of the 1.7.4 bundle (written out: 1.5 MB is no large file).
    const bundled = fake("control-bundle-sized");
    appendFileSync(bundled.bin, `/*${" ".repeat(1_571_351 - statSync(bundled.bin).size - 5)}*/\n`);
    for (const [pin, ran, minimumTurns] of [
      [wrapper, bundle.log, 1],
      [bundled.bin, bundled.log, 16],
    ] as const) {
      const read = await duringCheck(() => commitlorePinIdentity(pin));
      expect(read.turns).toBeGreaterThanOrEqual(minimumTurns);
      expect(read.value).toMatchObject({ size: String(statSync(pin).size), sha256: createHash("sha256").update(readFileSync(pin)).digest("hex") });
      expect(statSync(pin).size).toBeLessThanOrEqual(CAP);
      const observed = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, pin)).observe(tempDir("acp-s16-r2-control-checkout-"));
      expect(observed).toMatchObject({ outcome: "PASS" });
      expect(argvs(ran)).toEqual(OBSERVATION);
    }
    expect(statSync(wrapper).size).toBeLessThan(4_096);
    expect(statSync(bundled.bin).size).toBe(1_571_351);
    witnessed("S16-R2-01 normal-entrypoint control asserted");
  });
});
