import { execFileSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMITLORE_LIMITS,
  COMMITLORE_OBSERVATION_ARGV,
  commitloreRunner,
  createCommitLoreCliPort,
  probeCommitLore,
} from "../../src/bootstrap/commitlore-observation.ts";
import { COMMITLORE_INIT_OPTIONS, judgeCommitLoreVersion } from "../../src/bootstrap/commitlore-pin.ts";
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
