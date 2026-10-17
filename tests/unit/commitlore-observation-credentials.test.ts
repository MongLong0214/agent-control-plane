import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  commitloreChildEnvironment,
  createCommitLoreCliPort,
  requiredCommitLoreObservation,
} from "../../src/bootstrap/commitlore-observation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Review S11-R3 (PR #1138, CEO cb5501eb) — no credential reaches a `commitlore` child indirectly: not
 * through the daemon's HOME (its global git config and its `.netrc`), the system git config, a config
 * injected through the daemon's environment, or the checkout's own config (a credential helper or an
 * askpass program). Each source holds a real sentinel: an executable that leaves a mark when git runs it,
 * and prints no credential, so git goes on to the next one and every reachable sentinel leaves its mark.
 * A server on loopback asks every request for credentials and marks any it is sent.
 *
 * The child stands in for CommitLore: like `commitlore init` it installs hooks and reaches a remote, and
 * its git calls, and the hooks they run, all ask for a credential. Before anything is judged, the same
 * calls made with the daemon's configuration show every sentinel runs, so a sentinel that stays silent
 * under the child's environment was blocked, not unreachable.
 *
 * Nothing here reads the real git configuration: every git this file runs, and every HOME it names, is
 * a temporary one of this run. The system config a test cannot write is the sentinel file, given to git
 * through `GIT_CONFIG_SYSTEM`, git's own relocation of its compiled-in system file.
 */

afterEach(() => vi.unstubAllEnvs());

const root = tempDir("acp-s11-r3-credentials-");
const marks = join(root, "marks");
const sentinels = join(root, "sentinels");
const daemonHome = join(root, "daemon-home");
const systemConfig = join(root, "system.gitconfig");
const pushed = join(root, "pushed.git");
const SOURCES = ["system", "global", "global-url", "env-parameters", "env-count", "local", "local-url", "askpass"] as const;
type Source = (typeof SOURCES)[number];
const ACCESS = "http-authorization";
/**
 * The scopes a credential can also reach git from without any helper, as an HTTP header the
 * command-scope `credential.helper=` does not clear: each carries a header naming it, and the server
 * marks every one it is sent. These make each scope's own control load-bearing on its own.
 */
const HEADER_SOURCES = ["system", "global", "env-parameters", "env-count"] as const;
const headerConfig = (source: (typeof HEADER_SOURCES)[number]): string => `X-Acp-Sentinel-${source}: 1`;
const HEADER_MARKS = HEADER_SOURCES.map((source) => `header-${source}`);
const ok = JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] });

/** The git this file uses to build its fixtures: no HOME, global or system config of the host's. */
const SETUP_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: join(root, "setup-home"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
};
const setupGit = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, env: SETUP_ENV, stdio: "pipe", timeout: 20_000 });
};

const sentinel = (source: Source): string => join(sentinels, `credential-${source}`);
const ran = (): string[] => readdirSync(marks).sort();
const resetMarks = (): void => {
  rmSync(marks, { recursive: true, force: true });
  mkdirSync(marks);
};

let server: Server;
let port = 0;
const remote = (): string => `http://127.0.0.1:${port}/sentinel.git`;

/** A checkout carrying the repository-local sentinels: a helper, a URL-scoped helper and an askpass. */
const checkout = (name: string, origin: string | null): string => {
  const path = join(root, name);
  mkdirSync(path);
  setupGit(path, ["init", "-q"]);
  setupGit(path, ["config", "user.name", "acp-s11-r3"]);
  setupGit(path, ["config", "user.email", "acp-s11-r3@example.invalid"]);
  setupGit(path, ["config", "credential.helper", sentinel("local")]);
  setupGit(path, ["config", `credential.http://127.0.0.1:${port}.helper`, `!${sentinel("local-url")}`]);
  setupGit(path, ["config", "core.askPass", sentinel("askpass")]);
  if (origin !== null) setupGit(path, ["remote", "add", "origin", origin]);
  setupGit(path, ["commit", "-q", "--allow-empty", "-m", "bootstrap"]);
  return path;
};

/**
 * What the daemon's environment can carry into git: config injected the way git exports the push's
 * `-c credential.helper=…` to a hook (`GIT_CONFIG_PARAMETERS`), and the documented `GIT_CONFIG_COUNT` form.
 */
const DAEMON_INJECTION = (): Record<string, string> => ({
  GIT_CONFIG_PARAMETERS: `'credential.helper'='${sentinel("env-parameters")}' 'http.extraheader'='${headerConfig("env-parameters")}'`,
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: sentinel("env-count"),
  GIT_CONFIG_KEY_1: "http.extraHeader",
  GIT_CONFIG_VALUE_1: headerConfig("env-count"),
});
/** The daemon this observation runs in: the sentinel HOME, and the injection above. */
const injectDaemonEnvironment = (): void => {
  vi.stubEnv("HOME", daemonHome);
  for (const [name, value] of Object.entries(DAEMON_INJECTION())) vi.stubEnv(name, value);
};

/**
 * A `commitlore` that is `body`, run by this Node, with the fixture paths it needs baked in, pinned by
 * `ACP_COMMITLORE_BINARY` (slice S16) and answering the pin's checks before anything else; its directory is
 * also first on this process's PATH.
 */
const fake = (name: string, body: string): void => {
  const dir = tempDir(`acp-s11-r3-${name}-`);
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  const prelude = `
    if (process.argv[2] === '--version') { process.stdout.write('1.7.3\\n'); return; }
    if (process.argv[2] === 'doctor' && process.argv[3] === '--help') { process.stdout.write('Usage: commitlore doctor [options]\\n  --json  emit the report as JSON\\n'); return; }
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const step = process.argv[2];
    const LOG = ${JSON.stringify(join(root, `${name}.log`))};
    const log = (entry) => fs.appendFileSync(LOG, JSON.stringify({ step, ...entry }) + '\\n');
    // This host's git, with the sentinel file as its system config.
    const env = { ...process.env, GIT_CONFIG_SYSTEM: ${JSON.stringify(systemConfig)} };
    const git = (args, input) => {
      const run = spawnSync('git', args, { env, input: input ?? '', encoding: 'utf8', timeout: 20000 });
      log({ git: args.join(' '), status: run.status, stderr: String(run.stderr ?? '').slice(-400) });
      return run.status;
    };
    const fill = 'protocol=http\\nhost=127.0.0.1:${port}\\n\\n';
  `;
  writeFileSync(join(dir, "commitlore"), `#!${process.execPath}\n${prelude}\n${body}\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
  vi.stubEnv("ACP_COMMITLORE_BINARY", join(dir, "commitlore"));
};

const readLog = (name: string): Array<Record<string, unknown>> =>
  readFileSync(join(root, `${name}.log`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** Runs `args` with `env` without blocking this process, which serves the loopback remote. */
const gitAsync = (cwd: string, args: string[], env: NodeJS.ProcessEnv, input = ""): Promise<void> =>
  new Promise((resolve) => {
    const child = execFile("git", args, { cwd, env, timeout: 20_000 }, () => resolve());
    child.stdin?.end(input);
  });

beforeAll(async () => {
  mkdirSync(sentinels);
  mkdirSync(daemonHome);
  mkdirSync(SETUP_ENV.HOME);
  resetMarks();
  for (const source of SOURCES) {
    writeFileSync(sentinel(source), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(marks, source)}'\n`, { mode: 0o700 });
  }
  server = createServer((request, response) => {
    if (request.headers.authorization !== undefined) appendFileSync(join(marks, ACCESS), `${request.url}\n`);
    for (const name of Object.keys(request.headers)) {
      if (name.startsWith("x-acp-sentinel-")) appendFileSync(join(marks, `header-${name.slice("x-acp-sentinel-".length)}`), `${request.url}\n`);
    }
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="acp-s11-r3"' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // The daemon's HOME, shaped like the one measured: GitHub routed to a helper, as `gh` is, and a
  // `.netrc` that git's HTTP transport reads whatever the config says.
  writeFileSync(
    join(daemonHome, ".gitconfig"),
    `[credential]\n\thelper = ${sentinel("global")}\n[credential "http://127.0.0.1:${port}"]\n\thelper = !${sentinel("global-url")}\n[http]\n\textraHeader = ${headerConfig("global")}\n`,
  );
  writeFileSync(join(daemonHome, ".netrc"), "machine 127.0.0.1 login acp-s11-r3 password acp-s11-r3-netrc\n", { mode: 0o600 });
  writeFileSync(systemConfig, `[credential]\n\thelper = ${sentinel("system")}\n[http]\n\textraHeader = ${headerConfig("system")}\n`);
  setupGit(root, ["init", "-q", "--bare", pushed]);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  cleanupTempDirs();
});

describe("S11-R3: a CommitLore child reaches no credential, through its own git calls or the hooks they run", () => {
  let observedOutcome = "";
  let observedHomes: Array<Record<string, unknown>> = [];

  it("liveness: with the daemon's configuration, every sentinel runs and the server is sent every credential", async () => {
    const repo = checkout("liveness", remote());
    resetMarks();
    const daemon: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: daemonHome,
      GIT_CONFIG_SYSTEM: systemConfig,
      ...DAEMON_INJECTION(),
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    };
    await gitAsync(repo, ["credential", "fill"], daemon, `protocol=http\nhost=127.0.0.1:${port}\n\n`);
    await gitAsync(repo, ["ls-remote", "origin"], daemon);
    expect(ran()).toEqual([...SOURCES, ACCESS, ...HEADER_MARKS].sort());
  });

  it("runs init (which installs hooks, commits and pushes) and doctor in a child under the sentinels", async () => {
    const repo = checkout("observed", remote());
    const hooksLog = join(root, "hooks.log");
    const hook = [
      "#!/bin/sh",
      `printf 'protocol=http\\nhost=127.0.0.1:${port}\\n\\n' | git credential fill >/dev/null 2>'${hooksLog}.err'`,
      `echo "\${0##*/} credential-fill $? $(tail -n 1 '${hooksLog}.err')" >> '${hooksLog}'`,
      `git ls-remote origin >/dev/null 2>'${hooksLog}.err'`,
      `echo "\${0##*/} ls-remote $? $(tail -n 1 '${hooksLog}.err')" >> '${hooksLog}'`,
      "exit 0",
    ].join("\n");
    fake(
      "observed",
      `
      const home = process.env.HOME;
      const globalConfig = process.env.GIT_CONFIG_GLOBAL ?? null;
      log({ home, mode: (fs.statSync(home).mode & 0o777).toString(8), entries: fs.readdirSync(home).sort(),
            globalConfig, globalBytes: globalConfig === null ? null : fs.statSync(globalConfig).size });
      if (step === 'init') {
        for (const name of ['pre-push', 'post-commit']) fs.writeFileSync('.git/hooks/' + name, ${JSON.stringify(hook)}, { mode: 0o700 });
      }
      git(['credential', 'fill'], fill);
      git(['ls-remote', 'origin']);
      if (step === 'init') {
        git(['commit', '-q', '--allow-empty', '-m', 'hook path']);
        git(['push', '-q', ${JSON.stringify(pushed)}, 'HEAD:refs/heads/hook-path']);
      } else {
        console.log(${JSON.stringify(ok)});
      }
    `,
    );
    injectDaemonEnvironment();
    resetMarks();
    observedOutcome = (await createCommitLoreCliPort().observe(repo)).outcome;
    const log = readLog("observed");
    observedHomes = log.filter((entry) => "home" in entry);
    // Every credential request was made, reached git's credential step and found nothing there.
    const requests = log.filter((entry) => entry["git"] === "credential fill" || entry["git"] === "ls-remote origin");
    expect(requests.map((entry) => [entry["step"], entry["git"]])).toEqual([
      ["init", "credential fill"],
      ["init", "ls-remote origin"],
      ["doctor", "credential fill"],
      ["doctor", "ls-remote origin"],
    ]);
    for (const request of requests) {
      expect(request["status"], JSON.stringify(request)).not.toBe(0);
      expect(request["stderr"], JSON.stringify(request)).toMatch(/terminal prompts disabled/);
    }
    // The hook path: the commit and the push ran, so did both hooks, and each hook's requests failed alike.
    expect(log.filter((entry) => entry["git"] !== "credential fill" && entry["git"] !== "ls-remote origin" && "git" in entry).map((entry) => entry["status"])).toEqual([0, 0]);
    const hooks = readFileSync(hooksLog, "utf8").trim().split("\n");
    expect(hooks.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "post-commit credential-fill",
      "post-commit ls-remote",
      "pre-push credential-fill",
      "pre-push ls-remote",
    ]);
    for (const line of hooks) expect(line).toMatch(/^\S+ \S+ (?!0 )\d+ .*terminal prompts disabled/);
  });

  it("observes PASS: nothing the child was denied is a CommitLore failure", () => {
    expect(observedOutcome).toBe("PASS");
  });

  it.each(SOURCES)("the %s sentinel never runs", (source) => {
    expect(ran()).not.toContain(source);
  });

  it("the daemon HOME's .netrc never reaches a server", () => {
    expect(ran()).not.toContain(ACCESS);
  });

  it.each(HEADER_SOURCES)("the %s config's credential header never reaches a server", (source) => {
    expect(ran()).not.toContain(`header-${source}`);
  });

  it("each child has its own home: 0700, not the daemon's, an empty global config, removed after", () => {
    expect(observedHomes.map((entry) => entry["step"])).toEqual(["init", "doctor"]);
    const homes = observedHomes.map((entry) => entry["home"] as string);
    expect(new Set(homes).size).toBe(2);
    for (const entry of observedHomes) {
      const home = entry["home"] as string;
      expect(home).not.toBe(daemonHome);
      expect(entry).toMatchObject({ mode: "700", entries: [".gitconfig"], globalConfig: join(home, ".gitconfig"), globalBytes: 0 });
      expect(existsSync(home), home).toBe(false);
    }
  });

  it("the controls are ACP's own values, whatever the daemon's environment injects", () => {
    injectDaemonEnvironment();
    const environment = commitloreChildEnvironment("/acp-s11-r3/home");
    expect(Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith("GIT_") || name === "HOME"))).toEqual({
      HOME: "/acp-s11-r3/home",
      GIT_CONFIG_GLOBAL: "/acp-s11-r3/home/.gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_ASKPASS: "",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

describe("S11-R3 control: a required CommitLore that cannot reach its remote is still refused, with no credential", () => {
  // `init` reaches the checkout's remote and fails as git fails: no remote, one nothing listens on, and
  // one that asks for credentials.
  const cases: Array<[string, () => string | null]> = [
    ["no remote", () => null],
    ["an unreachable remote", () => "http://127.0.0.1:1/sentinel.git"],
    ["a remote that asks for credentials", remote],
  ];
  it.each(cases)("%s", async (label, origin) => {
    const name = `control-${label.replaceAll(" ", "-")}`;
    const repo = checkout(name, origin());
    fake(name, `process.exit(git(['ls-remote', 'origin']) ?? 1);`);
    injectDaemonEnvironment();
    resetMarks();
    const decision = await requiredCommitLoreObservation(createCommitLoreCliPort(), repo);
    expect(decision).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED" } });
    expect(readLog(name).map((entry) => [entry["git"], entry["status"]])).toEqual([["ls-remote origin", 128]]);
    expect(ran()).toEqual([]);
  });
});
