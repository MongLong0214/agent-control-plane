import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import {
  __testing as sandboxTesting,
  runSandboxed,
  SANDBOX_CACHE_HOME_PATHS,
  SANDBOX_SECRET_PATHS,
  type SandboxOutcome,
} from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";
import { stableFixtureLink } from "../helpers/stable-fixture-executable.ts";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

/**
 * Owner directive 2026-10-31: the verification sandbox runs any language, reads the filesystem and
 * the toolchains under HOME, writes its worktree, TMPDIR and the named toolchain caches, and has
 * outbound network and local IPC. One guard stays: the secret stores in `SANDBOX_SECRET_PATHS`
 * cannot be read, written or reached through a socket, and no credential crosses in the environment.
 *
 * HOME here is the private one `tests/helpers/isolated-home.ts` made for this file, so every secret
 * path below is a synthetic one; nothing reads or writes the operator's home.
 */

afterEach(cleanupTempDirs);

const servers: Server[] = [];
const scratchDirs: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const described = (outcome: SandboxOutcome): string =>
  `sandbox ${outcome.status} exit=${outcome.exitCode} reason=${outcome.reasonCode ?? "none"} ` +
  `stdout: ${outcome.stdout.trim().slice(-1_500)} stderr: ${outcome.stderr.trim().slice(-1_500)}`;

const run = (argv: string[], worktreePath: string, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) =>
  runSandboxed({
    command: parseVerificationCommand({ id: "open-sandbox", argv, timeoutSeconds: 60, maxMemoryMb: 1024 }),
    worktreePath,
    processLimit: "supervised-budget",
    ...extra,
  });

/** A node script in the worktree that prints one JSON line. */
const nodeScript = async (source: string, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) => {
  const repository = makeRepo();
  writeFiles(repository, { "probe.cjs": source });
  const outcome = await run(["node", "probe.cjs"], repository, extra);
  return { outcome, result: outcome.stdout.trim() ? JSON.parse(outcome.stdout.trim().split("\n").at(-1)!) : null };
};

const home = homedir();

/** Entries of the secret list that are files; every other entry is a directory. */
const SECRET_FILES = new Set([
  "~/.netrc", "~/.npmrc", "~/.pypirc", "~/.gitconfig", "~/.git-credentials", "~/.claude.json",
  "~/.docker/config.json", "~/.config/git/credentials", "~/.gem/credentials", "~/.cargo/credentials",
  "~/.cargo/credentials.toml", "~/.m2/settings.xml", "~/.m2/settings-security.xml", "~/.gradle/gradle.properties",
]);

const homeSecrets = SANDBOX_SECRET_PATHS.filter((entry) => entry.startsWith("~/"));

/** Where a probe reads and writes for one secret entry, created in the synthetic HOME. */
const plantSecret = (entry: string): { entry: string; readPath: string; writePath: string } => {
  const path = join(home, entry.slice(2));
  if (SECRET_FILES.has(entry)) {
    mkdirSync(dirname(path), { recursive: true });
    // A comment line, so a planted ~/.gitconfig still parses for this file's own git.
    writeFileSync(path, `# synthetic secret for ${entry}\n`);
    return { entry, readPath: path, writePath: path };
  }
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "synthetic-secret"), `# synthetic secret for ${entry}\n`);
  return { entry, readPath: join(path, "synthetic-secret"), writePath: join(path, "planted") };
};

const listen = async (path: string): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const server = createServer((socket) => socket.end("agent-answered\n"));
  servers.push(server);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolveListen());
  });
};

describe("the verification sandbox opens to every language", () => {
  it("runs under a synthetic HOME, never the operator's", () => {
    expect(home).not.toBe(userInfo().homedir);
    expect(home).toContain("acp-test-home-");
  });

  it("runs python3 and records its exit status as PASS or FAIL", async (context) => {
    requireSeatbelt(context);
    const repository = makeRepo();
    writeFiles(repository, {
      "passes.py": "import sys\nprint('python ran', sys.version_info[0])\n",
      "fails.py": "import sys\nprint('python test failed')\nsys.exit(3)\n",
    });
    const passed = await run(["python3", "passes.py"], repository);
    expect(passed, described(passed)).toMatchObject({ status: "PASS", exitCode: 0, reasonCode: null });
    expect(passed.stdout.trim()).toBe("python ran 3");
    const failed = await run(["python3", "fails.py"], repository);
    expect(failed, described(failed)).toMatchObject({ status: "FAIL", exitCode: 3 });
    expect(failed.stdout.trim()).toBe("python test failed");
  });

  it("runs other non-Node executables: ruby, make and bash", async (context) => {
    requireSeatbelt(context);
    const repository = makeRepo();
    writeFiles(repository, { "Makefile": "check:\n\t@echo make ran\n", "check.sh": "echo bash ran\n" });
    const ruby = await run(["ruby", "-e", "puts 'ruby ran'"], repository);
    expect(ruby, described(ruby)).toMatchObject({ status: "PASS", exitCode: 0 });
    expect(ruby.stdout.trim()).toBe("ruby ran");
    const make = await run(["make", "-s", "check"], repository);
    expect(make, described(make)).toMatchObject({ status: "PASS", exitCode: 0 });
    expect(make.stdout.trim()).toBe("make ran");
    const bash = await run(["bash", "check.sh"], repository);
    expect(bash, described(bash)).toMatchObject({ status: "PASS", exitCode: 0 });
    expect(bash.stdout.trim()).toBe("bash ran");
    const failing = await run(["ruby", "-e", "exit 4"], repository);
    expect(failing, described(failing)).toMatchObject({ status: "FAIL", exitCode: 4 });
  });

  it("gives the command the daemon's HOME, so a toolchain file under it is found and read", async (context) => {
    requireSeatbelt(context);
    writeFiles(home, {
      ".pyenv/version": "3.12.7\n",
      "Library/Application Support/acp-toolchain/config.toml": "channel = \"stable\"\n",
    });
    const { outcome, result } = await nodeScript(`
      const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
      console.log(JSON.stringify({
        home: os.homedir(),
        pyenv: fs.readFileSync(path.join(os.homedir(), '.pyenv', 'version'), 'utf8'),
        support: fs.readFileSync(path.join(os.homedir(), 'Library', 'Application Support', 'acp-toolchain', 'config.toml'), 'utf8'),
      }));
    `);
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS" });
    expect(result).toEqual({ home, pyenv: "3.12.7\n", support: "channel = \"stable\"\n" });
  });

  it("writes the named toolchain caches under HOME, creating their parents", async (context) => {
    requireSeatbelt(context);
    rmSync(join(home, ".cargo"), { recursive: true, force: true });
    rmSync(join(home, "go"), { recursive: true, force: true });
    const probes = [".npm/_cacache/acp-probe", "Library/Caches/pip/acp-probe", ".cargo/registry/acp-probe", "go/pkg/mod/acp-probe"];
    const { outcome, result } = await nodeScript(`
      const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
      const results = {};
      for (const probe of ${JSON.stringify(probes)}) {
        const target = path.join(os.homedir(), probe);
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, 'cached');
          results[probe] = 'OK';
        } catch (error) { results[probe] = error.code; }
      }
      console.log(JSON.stringify(results));
    `);
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS" });
    expect(result).toEqual(Object.fromEntries(probes.map((probe) => [probe, "OK"])));
    for (const probe of probes) expect(readFileSync(join(home, probe), "utf8")).toBe("cached");
    expect(SANDBOX_CACHE_HOME_PATHS).toEqual(expect.arrayContaining([".npm", "Library/Caches/pip", ".cargo/registry", "go/pkg/mod"]));
  });

  it("refuses a write outside the worktree, TMPDIR and the named caches", async (context) => {
    requireSeatbelt(context);
    const otherCheckout = makeRepo();
    const outside = tempDir("acp-open-sandbox-outside-");
    const targets = [
      join(home, "not-a-cache.txt"),
      join(home, ".cargo", "bin", "cargo"),
      join(home, ".cargo", "config.toml"),
      join(home, "go", "bin", "tool"),
      join(home, ".rustup", "toolchains", "planted"),
      join(home, ".gradle", "init.d", "planted.gradle"),
      join(home, ".local", "bin", "planted"),
      join(home, "Library", "LaunchAgents", "planted.plist"),
      join(otherCheckout, "planted.txt"),
      join(outside, "planted.txt"),
    ];
    // Every parent exists, so a refusal can only be the sandbox's.
    for (const target of targets) mkdirSync(dirname(target), { recursive: true });
    const { outcome, result } = await nodeScript(`
      const fs = require('node:fs');
      const results = {};
      for (const target of ${JSON.stringify(targets)}) {
        try { fs.writeFileSync(target, 'planted'); results[target] = 'WRITTEN'; }
        catch (error) { results[target] = error.code; }
      }
      try { fs.writeFileSync('inside.txt', 'ok'); results.worktree = 'OK'; } catch (error) { results.worktree = error.code; }
      try { fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(), 't'), 'ok'); results.tmpdir = 'OK'; } catch (error) { results.tmpdir = error.code; }
      console.log(JSON.stringify(results));
    `, { denyReadPaths: [otherCheckout] });
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS" });
    expect(result).toMatchObject({ worktree: "OK", tmpdir: "OK" });
    for (const target of targets) {
      expect(result[target], target).toBe("EPERM");
      expect(existsSync(target), target).toBe(false);
    }
  });

  it("allows local unix-socket and loopback IPC, in the worktree and in TMPDIR", async (context) => {
    requireSeatbelt(context);
    const { outcome, result } = await nodeScript(`
      const net = require('node:net'), os = require('node:os');
      const roundTrip = (listenArgs) => new Promise((resolve) => {
        const server = net.createServer((socket) => socket.end('pong'));
        server.on('error', (error) => resolve(error.code));
        server.listen(...listenArgs, () => {
          const address = server.address();
          const target = typeof address === 'string' ? { path: listenArgs[0] } : { host: '127.0.0.1', port: address.port };
          const client = net.connect(target);
          let data = '';
          client.on('data', (chunk) => { data += chunk; });
          client.on('error', (error) => { server.close(); resolve(error.code); });
          client.on('end', () => { server.close(); resolve(data); });
        });
      });
      (async () => {
        const worktree = await roundTrip(['ipc.sock']);
        process.chdir(os.tmpdir());
        const tmpdir = await roundTrip(['ipc.sock']);
        const loopback = await roundTrip([0, '127.0.0.1']);
        console.log(JSON.stringify({ worktree, tmpdir, loopback }));
      })();
    `);
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS" });
    expect(result).toEqual({ worktree: "pong", tmpdir: "pong", loopback: "pong" });
  });

  it("records the open network in the evidence instead of claiming it was denied", async (context) => {
    requireSeatbelt(context);
    const { outcome } = await nodeScript("console.log(JSON.stringify({ ok: true }));");
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      enforcement: {
        mechanism: "seatbelt",
        networkPolicy: "allow",
        networkEnforced: false,
        writeConfinement: true,
        readConfinement: "sensitive-paths",
      },
    });
  });
});

describe("the one guard that stays: secret paths, credential environment and agent sockets", () => {
  it("refuses reading and writing every guarded secret path", async (context) => {
    requireSeatbelt(context);
    const planted = homeSecrets.map(plantSecret);
    const stateDir = tempDir("acp-open-sandbox-state-");
    writeFileSync(join(stateDir, "acp.sqlite"), "synthetic state\n");
    planted.push({ entry: "denyReadPaths", readPath: join(stateDir, "acp.sqlite"), writePath: join(stateDir, "acp.sqlite") });
    const { outcome, result } = await nodeScript(`
      const fs = require('node:fs');
      const results = {};
      for (const { entry, readPath, writePath } of ${JSON.stringify(planted)}) {
        let read, write;
        try { fs.readFileSync(readPath); read = 'READ'; } catch (error) { read = error.code; }
        try { fs.appendFileSync(writePath, 'planted'); write = 'WRITTEN'; } catch (error) { write = error.code; }
        results[entry] = { read, write };
      }
      console.log(JSON.stringify(results));
    `, { denyReadPaths: [stateDir] });
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS" });
    for (const { entry, readPath, writePath } of planted) {
      expect(result[entry], entry).toEqual({ read: "EPERM", write: "EPERM" });
      expect(readFileSync(readPath, "utf8"), entry).not.toContain("planted");
      if (writePath !== readPath) expect(existsSync(writePath), entry).toBe(false);
    }
    expect(homeSecrets).toEqual(expect.arrayContaining([
      "~/.ssh", "~/.gnupg", "~/.config/gh", "~/.netrc", "~/.aws", "~/.docker/config.json", "~/.kube",
      "~/Library/Keychains", "~/.agent-control-plane", "~/.hermes", "~/.claude", "~/.claude.json", "~/.codex",
      "~/.buzz",
    ]));
  });

  it("keeps git working under a HOME whose ~/.gitconfig is denied", async (context) => {
    requireSeatbelt(context);
    plantSecret("~/.gitconfig");
    const repository = makeRepo();
    const outcome = await run(["git", "status", "--porcelain"], repository);
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS", exitCode: 0 });
  });

  it("refuses a connection to an agent, keyring or container socket", async (context) => {
    requireSeatbelt(context);
    const launchd = `/private/tmp/com.apple.launchd.acp${randomUUID().slice(0, 8)}`;
    scratchDirs.push(launchd);
    const control = `/private/tmp/acp-ctl-${randomUUID().slice(0, 8)}.sock`;
    scratchDirs.push(control);
    const sockets = {
      "ssh-agent (SSH_AUTH_SOCK)": join(launchd, "Listeners"),
      "~/.ssh": join(home, ".ssh", "agent.sock"),
      "~/.gnupg": join(home, ".gnupg", "S.gpg-agent"),
      "~/.orbstack": join(home, ".orbstack", "run", "docker.sock"),
      "~/.docker/run": join(home, ".docker", "run", "docker.sock"),
      "~/.agent-control-plane": join(home, ".agent-control-plane", "op.sock"),
      control,
    };
    for (const path of Object.values(sockets)) await listen(path);
    const previous = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = sockets["ssh-agent (SSH_AUTH_SOCK)"];
    let probe;
    try {
      probe = await nodeScript(`
        const net = require('node:net');
        const connect = (path) => new Promise((resolve) => {
          const client = net.connect({ path });
          let data = '';
          client.on('data', (chunk) => { data += chunk; });
          client.on('error', (error) => resolve(error.code));
          client.on('end', () => resolve(data.trim()));
        });
        (async () => {
          const results = { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? null };
          for (const [label, path] of Object.entries(${JSON.stringify(sockets)})) results[label] = await connect(path);
          console.log(JSON.stringify(results));
        })();
      `, {
        command: parseVerificationCommand({ id: "sockets", argv: ["node", "probe.cjs"], envAllowlist: ["SSH_AUTH_SOCK"] }),
        env: { SSH_AUTH_SOCK: sockets["ssh-agent (SSH_AUTH_SOCK)"] },
      });
    } finally {
      if (previous === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = previous;
    }
    expect(probe.outcome, described(probe.outcome)).toMatchObject({ status: "PASS" });
    const { control: reached, SSH_AUTH_SOCK: pointer, ...guarded } = probe.result as Record<string, string | null>;
    expect(pointer).toBeNull();
    expect(reached).toBe("agent-answered");
    expect(guarded).toEqual(Object.fromEntries(Object.keys(sockets).filter((label) => label !== "control").map((label) => [label, "EPERM"])));
  });

  it("passes no token-bearing variable into the command, even one its contract names", async (context) => {
    requireSeatbelt(context);
    const tokens = [
      "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN", "NPM_TOKEN", "ACP_OPERATOR_TOKEN", "ACP_MCP_TOKEN", "API_SERVER_KEY",
      "ACP_HERMES_GATEWAY_API_KEY", "BUZZ_PRIVATE_KEY", "SERVICE_SECRET", "SIGNING_KEY", "SSH_AUTH_SOCK", "GPG_AGENT_INFO",
      "DOCKER_HOST",
    ];
    const synthetic = Object.fromEntries(tokens.map((name) => [name, `synthetic-${name.toLowerCase()}-value`]));
    const previous = Object.fromEntries(tokens.map((name) => [name, process.env[name]]));
    Object.assign(process.env, synthetic);
    let probe;
    try {
      probe = await nodeScript("console.log(JSON.stringify(process.env));", {
        command: parseVerificationCommand({ id: "env", argv: ["node", "probe.cjs"], envAllowlist: tokens }),
        env: synthetic,
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(probe.outcome, described(probe.outcome)).toMatchObject({ status: "PASS" });
    const seen = probe.result as Record<string, string>;
    for (const name of tokens) expect(seen[name], name).toBeUndefined();
    expect(Object.values(seen).join("\n")).not.toContain("synthetic-");
    // GIT_CONFIG_KEY_<n> names a git setting the sandbox pins, not a key.
    expect(Object.keys(seen).filter((name) => /TOKEN|SECRET|_KEY|PASSWORD|AUTH/.test(name) && !/^GIT_CONFIG_KEY_\d+$/.test(name))).toEqual([]);
    expect(seen["HOME"]).toBe(home);
  });
});

/** Runs `operation` with `values` set in the daemon's environment, then restores it. */
const withDaemonEnv = async <T>(values: Record<string, string>, operation: () => Promise<T>): Promise<T> => {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

/** The profile the sandbox would apply for a worktree, under the daemon environment in force now. */
const profileText = (): string =>
  sandboxTesting.seatbeltProfile(tempDir("acp-open-sandbox-profile-"), tempDir("acp-open-sandbox-profile-scratch-"), []);

describe("review P1s: a symlinked cache and the daemon's own agent sockets", () => {
  it("grants no write through a cache entry that is a symlink out of HOME (P1-1)", async (context) => {
    requireSeatbelt(context);
    const tag = randomUUID().slice(0, 8);
    const symlinkedHome = join(home, `symlinked-home-${tag}`);
    const unrelated = `/private/tmp/acp-unrelated-project-${tag}`;
    scratchDirs.push(unrelated);
    mkdirSync(symlinkedHome, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    symlinkSync(unrelated, join(symlinkedHome, ".npm"));
    const { outcome, result } = await withDaemonEnv({ HOME: symlinkedHome }, () => nodeScript(`
      const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
      const attempt = (target) => { try { fs.writeFileSync(target, 'planted'); return 'WRITTEN'; } catch (error) { return error.code; } };
      console.log(JSON.stringify({
        throughLink: attempt(path.join(os.homedir(), '.npm', 'planted-through-link')),
        direct: attempt(${JSON.stringify(join(unrelated, "planted-direct"))}),
      }));
    `));
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS" });
    expect(result).toEqual({ throughLink: "EPERM", direct: "EPERM" });
    expect(existsSync(join(unrelated, "planted-through-link"))).toBe(false);
    expect(existsSync(join(unrelated, "planted-direct"))).toBe(false);
    const profile = await withDaemonEnv({ HOME: symlinkedHome }, async () => profileText());
    expect(profile).not.toContain(unrelated);
  });

  it("refuses a connection to the daemon's own SSH, GPG and Docker agent sockets wherever they live (P1-2)", async (context) => {
    requireSeatbelt(context);
    const tag = randomUUID().slice(0, 8);
    const sshAgent = `/private/tmp/custom-agent-${tag}.sock`;
    const perAgentDir = `/private/tmp/ssh-acp${tag}`;
    const gnupgHome = `/private/tmp/acp-gnupg-${tag}`;
    const docker = `/private/tmp/acp-docker-${tag}.sock`;
    const control = `/private/tmp/acp-ctl2-${tag}.sock`;
    scratchDirs.push(sshAgent, perAgentDir, gnupgHome, docker, control);
    const sockets = {
      SSH_AUTH_SOCK: sshAgent,
      "SSH_AUTH_SOCK, per-agent directory": join(perAgentDir, "agent.4242"),
      "sibling in the per-agent directory": join(perAgentDir, "agent.4243"),
      "GNUPGHOME agent": join(gnupgHome, "S.gpg-agent"),
      DOCKER_HOST: docker,
      control,
    };
    for (const path of Object.values(sockets)) await listen(path);
    const daemonEnv = { SSH_AUTH_SOCK: sshAgent, GNUPGHOME: gnupgHome, DOCKER_HOST: `unix://${docker}` };
    const connect = (pointer: Record<string, string>) => withDaemonEnv({ ...daemonEnv, ...pointer }, () => nodeScript(`
      const net = require('node:net');
      const connect = (path) => new Promise((resolve) => {
        const client = net.connect({ path });
        let data = '';
        client.on('data', (chunk) => { data += chunk; });
        client.on('error', (error) => resolve(error.code));
        client.on('end', () => resolve(data.trim()));
      });
      (async () => {
        const results = { pointer: process.env.SSH_AUTH_SOCK ?? null };
        for (const [label, path] of Object.entries(${JSON.stringify(sockets)})) results[label] = await connect(path);
        console.log(JSON.stringify(results));
      })();
    `));
    const first = await connect({});
    expect(first.outcome, described(first.outcome)).toMatchObject({ status: "PASS" });
    expect(first.result).toMatchObject({ pointer: null, SSH_AUTH_SOCK: "EPERM", "GNUPGHOME agent": "EPERM", DOCKER_HOST: "EPERM", control: "agent-answered" });
    const second = await connect({ SSH_AUTH_SOCK: sockets["SSH_AUTH_SOCK, per-agent directory"] });
    expect(second.outcome, described(second.outcome)).toMatchObject({ status: "PASS" });
    expect(second.result).toMatchObject({
      pointer: null,
      "SSH_AUTH_SOCK, per-agent directory": "EPERM",
      "sibling in the per-agent directory": "EPERM",
      control: "agent-answered",
    });
    const profile = await withDaemonEnv(daemonEnv, async () => profileText());
    expect(profile).toContain(`(deny network-outbound (remote unix-socket (subpath "${sshAgent}")))`);
    expect(profile).toContain(`(deny network-outbound (remote unix-socket (subpath "${docker}")))`);
    expect(profile).toContain(`(deny network-outbound (remote unix-socket (subpath "${gnupgHome}")))`);
    expect(profile).not.toContain(`(subpath "/private/tmp")`);
  });
});

describe("the supervisor never runs through the python3 xcrun stub (CI, 27518d67)", () => {
  // `/usr/bin/python3` is an xcrun stub. On a cold xcrun cache it writes `xcrun_db` in the per-user
  // temp directory, which the profile refuses (9efc1040's did too); on the CI runner the stub then
  // ran no supervisor: ERROR, empty stdout, "couldn't create cache file". A cold cache cannot be
  // made here without touching the user's own, so this proves the cause is gone instead: the
  // supervisor is the python3 of the active developer directory, never the stub.
  it("launches the supervisor as the developer directory's python3, not the xcrun stub", async (context) => {
    requireSeatbelt(context);
    const located = boundedSpawnSync("/usr/bin/xcrun", ["--find", "python3"], { encoding: "utf8" });
    if (located.status !== 0) context.skip("xcrun cannot locate python3 on this host");
    const real = String(located.stdout).trim();
    const developerDir = tempDir("acp-developer-dir-");
    mkdirSync(join(developerDir, "usr", "bin"), { recursive: true });
    stableFixtureLink(join(developerDir, "usr", "bin", "python3"), `#!/bin/sh\necho ACP_SUPERVISOR_FROM_DEVELOPER_DIR >&2\nexec ${JSON.stringify(real)} "$@"\n`);
    const repository = makeRepo();
    const outcome = await withDaemonEnv({ DEVELOPER_DIR: developerDir }, () => runSandboxed({
      command: parseVerificationCommand({ id: "launcher", argv: ["env", "NAME=VALUE", "sh", "-c", "printf pwned"], timeoutSeconds: 30 }),
      worktreePath: repository,
    }));
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS", stdout: "pwned" });
    expect(outcome.stderr).toContain("ACP_SUPERVISOR_FROM_DEVELOPER_DIR");
    expect(outcome.stderr).not.toContain("xcrun_db");
  });
});
