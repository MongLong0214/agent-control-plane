import { spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ControlPlane, defaultConfig } from "../../src/app/control-plane.ts";
import {
  parseVerificationCommand,
  type VerificationCommand,
} from "../../src/contracts/verification-command.ts";
import { databaseSidecarPaths } from "../../src/db/state-preflight.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunKind, SessionLifecycle } from "../../src/domain/types.ts";
import * as sandbox from "../../src/verify/sandbox.ts";
import { runSandboxed } from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

const legacyCommand = (argv: readonly string[]): VerificationCommand => ({
  id: "legacy-boundary-command",
  argv: [...argv],
  repositoryRole: "primary",
  cwd: ".",
  timeoutSeconds: 10,
  envAllowlist: [],
  network: "deny",
  networkAllowlist: [],
  required: true,
  evidenceMode: "LOCAL_COMMAND",
  maxOutputBytes: 1024,
  maxMemoryMb: 64,
});

const parserError = (argv: readonly string[]): string => {
  try {
    parseVerificationCommand({ id: "parser-boundary-command", argv });
    return "parser accepted the command";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Start with the allowlisted interpreter, then replace it with the shell under test. */
const nodeExecShell = (script: string): string => {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `process.execve('/bin/sh',['sh','-c',Buffer.from(${JSON.stringify(encoded)},'base64').toString()],process.env)`;
};

const shellCommand = (
  id: string,
  script: string,
  overrides: Record<string, unknown> = {},
): VerificationCommand => parseVerificationCommand({
  id,
  argv: ["node", "-e", nodeExecShell(script)],
  timeoutSeconds: 10,
  maxMemoryMb: 256,
  ...overrides,
});

interface ProbeRow {
  kind: string;
  label: string;
  status: string;
  errno: string;
  message: string;
}

const probeRows = (stdout: string): ProbeRow[] => stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [kind, label, status, errno, ...message] = line.split("\t");
    return { kind: kind ?? "", label: label ?? "", status: status ?? "", errno: errno ?? "", message: message.join("\t") };
  });

const assertDeniedRows = (stdout: string, labels: readonly string[]): void => {
  const rows = new Map(probeRows(stdout).map((row) => [row.label, row]));
  for (const label of labels) {
    const row = rows.get(label);
    expect(row, label).toBeDefined();
    expect(row?.status, label).not.toBe("0");
    // Keep the kernel's refusal in the assertion/report rather than proving only that a
    // success sentinel was absent. macOS renders EPERM as "Operation not permitted".
    expect(row?.errno, label).toBe("EPERM");
    expect(row?.message, label).toMatch(/Operation not permitted|Permission denied/);
  }
};

const pythonReadProbe = (probes: readonly { kind: string; label: string; path: string }[]): string => String.raw`
import errno, os
probes = ${JSON.stringify(probes)}
for probe in probes:
    kind, label, path = probe["kind"], probe["label"], probe["path"]
    try:
        if kind == "dir":
            os.listdir(path)
        else:
            with open(path, "rb") as handle:
                handle.read(1)
        status, error_name, message = "0", "OK", "OK"
    except OSError as error:
        status, error_name, message = "1", errno.errorcode.get(error.errno, "UNKNOWN"), str(error)
    print("\t".join((kind, label, status, error_name, message)))
`;

const pythonWriteProbe = (probes: readonly { label: string; path: string }[]): string => String.raw`
import errno, os
probes = ${JSON.stringify(probes)}
for probe in probes:
    label, path = probe["label"], probe["path"]
    path = os.path.expandvars(path)
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("probe")
        status, error_name, message = "0", "OK", "OK"
    except OSError as error:
        status, error_name, message = "1", errno.errorcode.get(error.errno, "UNKNOWN"), str(error)
    print("\t".join(("write", label, status, error_name, message)))
`;


/**
 * A python3 that actually runs. `/usr/bin/python3` on a GitHub macOS runner is an Xcode
 * shim that needs xcodebuild and a writable xcrun cache; the sandbox denies both, so a probe
 * pinned to it fails before reaching the boundary it is meant to measure.
 */
const usablePython3 = (): string => {
  for (const candidate of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (!existsSync(candidate)) continue;
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  return "/usr/bin/python3";
};

describe("handoff P1 child boundaries", () => {
  // The P1-14 cases that stood here drove `GhCliClient`, the `gh`-subprocess client this
  // repository no longer has: the App credential store replaced it, and the token is now
  // consumed by an in-process fetch. Their replacements live where the current code is —
  // `tests/unit/github-r2.test.ts` proves no child can carry the token (the module cannot
  // spawn, and the request completes with nothing on PATH), and
  // `tests/unit/github-app-credential-store.test.ts` proves the deadline and the response
  // byte bound on the store that actually runs. Deleting them here rather than porting them
  // is deliberate: a test that constructs a class nobody ships is not a boundary proof.

  it("P1-15 resolves allowlisted node forms by their real path", () => {
    const forms = ["node", relative(process.cwd(), process.execPath), process.execPath];
    for (const [index, argv0] of forms.entries()) {
      expect(
        () => parseVerificationCommand({ id: `node-form-${index}`, argv: [argv0, "-e", "process.exit(0)"] }),
      ).not.toThrow();
    }
  });

  it("P1-15 attempts all known launcher rounds and never exposes the shell sentinel", async () => {
    const attempts: readonly { label: string; argv: readonly string[] }[] = [
      { label: "env NAME=VALUE", argv: ["env", "NAME=VALUE", "sh", "-c", "printf pwned"] },
      { label: "env -S", argv: ["env", "-S", "X=1", "sh", "-c", "printf pwned"] },
      { label: "env --", argv: ["env", "--", "X=1", "sh", "-c", "printf pwned"] },
      { label: "env -P", argv: ["env", "-P", "/bin", "sh", "-c", "printf pwned"] },
      { label: "arch", argv: ["arch", "-arm64", "sh", "-c", "printf pwned"] },
    ];

    for (const attempt of attempts) {
      const parserResult = parserError(attempt.argv);
      expect(parserResult, attempt.label).toContain("verification executable allowlist");

      const outcome = await runSandboxed({
        command: legacyCommand(attempt.argv),
        worktreePath: tempDir(`acp-p1-15-${attempt.label.replaceAll(/[^a-z0-9]+/g, "-")}-`),
      });
      expect(`${outcome.stdout}\n${outcome.stderr}`, attempt.label).not.toContain("pwned");
      expect(outcome, attempt.label).toMatchObject({ status: "ERROR", reasonCode: "INVALID_ARGUMENT" });
      expect(outcome.stderr, attempt.label).toContain("verification executable allowlist");
      expect(outcome.stderr, attempt.label).toContain(attempt.argv[0]!);
    }
  });

  it("P1-15 refuses three executables outside the allowlist without running their sentinels", async () => {
    const attempts: readonly { label: string; argv: readonly string[] }[] = [
      { label: "open", argv: ["open", "sh", "-c", "printf pwned"] },
      { label: "script", argv: ["script", "sh", "-c", "printf pwned"] },
      { label: "caffeinate", argv: ["caffeinate", "sh", "-c", "printf pwned"] },
    ];

    for (const attempt of attempts) {
      const parserResult = parserError(attempt.argv);
      expect(parserResult, attempt.label).toContain("verification executable allowlist");

      const outcome = await runSandboxed({
        command: legacyCommand(attempt.argv),
        worktreePath: tempDir(`acp-p1-15-${attempt.label}-worktree-`),
      });
      expect(`${outcome.stdout}\n${outcome.stderr}`, attempt.label).not.toContain("pwned");
      expect(outcome, attempt.label).toMatchObject({ status: "ERROR", reasonCode: "INVALID_ARGUMENT" });
      expect(outcome.stderr, attempt.label).toContain("verification executable allowlist");
      expect(outcome.stderr, attempt.label).toContain(attempt.argv[0]!);
    }
  });

  it("P1-15 runs a manifest-declared environment without an env launcher", async () => {
    const command = parseVerificationCommand({
      id: "manifest-environment",
      argv: ["node", "-e", "process.stdout.write(process.env.NODE_ENV ?? 'missing')"],
      envAllowlist: ["NODE_ENV"],
    });
    const outcome = await runSandboxed({
      command,
      worktreePath: tempDir("acp-p1-15-environment-worktree-"),
      env: { NODE_ENV: "test" },
    });
    expect(outcome).toMatchObject({ status: "PASS", reasonCode: null });
    expect(outcome.stdout).toBe("test");
  });

  it("P1-15 proves production-layout state reads are denied after node execs a shell", async () => {
    const hostHome = tempDir("acp-p1-15-production-home-");
    const sandboxHome = tempDir("acp-p1-15-sandbox-home-");
    const stateRoot = join(hostHome, ".agent-control-plane");
    const config = defaultConfig(stateRoot);
    const clock = new ManualClock("2026-08-14T00:00:00.000Z");
    const adapter = new TestProductionAdapter(clock);
    adapter.setCapacity({
      provider: "scripted",
      sensorHealth: "HEALTHY",
      runtimeHealth: "HEALTHY",
      observedAt: clock.nowIso(),
      source: "handoff-p1-15-test",
      buckets: [{ id: "cto", remainingPercent: 100, resetAt: null, capabilities: ["cto"] }],
    });
    const controlPlane = new ControlPlane({
      ...config,
      clock,
      adapters: [adapter],
    });
    const repository = makeRepo({ "candidate.txt": "candidate input\n" });
    const file = (path: string): string => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, "state fixture", { mode: 0o600 });
      return path;
    };

    try {
      // This is the same root and managed worktree layout that defaultConfig and
      // ControlPlane use in production: $HOME/.agent-control-plane/{state.sqlite,backups,
      // capacity,secrets,worktrees,...}. The worktree is materialized by the real manager,
      // rather than arranged beside the fake home as the prior test did. The run and its
      // temporary repository make VerificationEngine create the disposable worktree itself.
      const contract = {
        goal: "exercise the production verification boundary",
        why: "P1-15 handoff regression",
        scope: [],
        nonGoals: [],
        acceptance: ["state reads are denied"],
        priority: "NORMAL" as const,
        humanGate: [],
        references: [],
      };
      const created = controlPlane.runs.create({
        kind: RunKind.PROJECT_BOOTSTRAP,
        executionMode: ExecutionMode.SIMPLE,
        contract,
      });
      if (!created.allowed) throw new Error(created.message);
      const registered = await controlPlane.repositories.registerTemporary(repository, created.value.runId);
      if (!registered.allowed) throw new Error(registered.message);
      const owner = controlPlane.sessions.create({ provider: "scripted", model: "handoff-p1-15-owner" });
      const ready = controlPlane.sessions.transition(owner.sessionId, SessionLifecycle.READY, "handoff test owner");
      if (!ready.allowed) throw new Error(ready.message);
      const bound = controlPlane.bootstrap.bindBootstrapCto(created.value.runId, owner.sessionId);
      if (!bound.allowed) throw new Error(bound.message);
      const dispatched = await controlPlane.runs.dispatch(created.value.runId);
      if (!dispatched.allowed) throw new Error(dispatched.message);
      const attached = controlPlane.runs.attachRepository(created.value.runId, {
        repositoryId: registered.value.repositoryId,
        repositoryRole: "primary",
        baseBranch: "dev",
        ownerSessionId: dispatched.value.ownerSessionId!,
        ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      });
      if (!attached.allowed) throw new Error(attached.message);
      const frozen = await controlPlane.pipeline.freeze(created.value.runId);
      if (!frozen.allowed) throw new Error(frozen.message);
      const sidecars = databaseSidecarPaths(config.databasePath);
      for (const sidecar of sidecars) {
        if (!existsSync(sidecar)) writeFileSync(sidecar, "sqlite sidecar fixture", { mode: 0o600 });
      }
      const backup = file(join(stateRoot, "backups", "state.sqlite-manual-fixture.sqlite"));
      const manifest = file(`${backup}.manifest.json`);
      const capacity = file(join(config.capacityDir, "claude.json"));
      const secret = file(join(config.secretsDir, "github.token"));

      // Verify the composition root actually installed the derived production deny family,
      // then use that installed path set for the attack rather than injecting an unrelated
      // path into runSandboxed. This assertion fails if the wiring regresses to only the DB.
      const configuredDenyReadPaths = [
        ...((controlPlane.verification as unknown as { extraDenyReadPaths: readonly string[] }).extraDenyReadPaths),
      ];
      expect(configuredDenyReadPaths).toEqual(expect.arrayContaining([
        stateRoot,
        config.databasePath,
        ...sidecars,
      ]));

      const paths = [
        { kind: "read", label: "database", path: config.databasePath },
        { kind: "read", label: "database -wal", path: sidecars[0]! },
        { kind: "read", label: "database -shm", path: sidecars[1]! },
        { kind: "read", label: "database -journal", path: sidecars[2]! },
        { kind: "dir", label: "backups directory", path: dirname(backup) },
        { kind: "read", label: "backup", path: backup },
        { kind: "read", label: "backup manifest", path: manifest },
        { kind: "read", label: "capacity", path: capacity },
        { kind: "dir", label: "secrets directory", path: config.secretsDir },
        { kind: "read", label: "secret", path: secret },
        // VerificationEngine creates the disposable worktree after this test constructs the
        // command, so a relative path proves the command's assigned cwd is still readable.
        { kind: "read", label: "current worktree", path: "candidate.txt" },
      ] as const;
      const script = `exec ${usablePython3()} -c ${shellQuote(pythonReadProbe(paths))}`;
      const previousHome = process.env["HOME"];
      // Keep the ambient sandbox HOME separate from the explicitly configured production
      // root. sensitiveReadPaths always denies $HOME/.agent-control-plane; this regression
      // must therefore prove the state-root deny that ControlPlane forwards to the engine.
      process.env["HOME"] = sandboxHome;
      let outcome: Awaited<ReturnType<typeof runSandboxed>> | null = null;
      const originalRunSandboxed = sandbox.runSandboxed;
      const runSandboxedSpy = vi.spyOn(sandbox, "runSandboxed").mockImplementation(async (request) => {
        const observed = await originalRunSandboxed(request);
        if (request.command.id === "production-layout-state-reads") outcome = observed;
        return observed;
      });
      try {
        const verified = await controlPlane.verification.verify({
          runId: created.value.runId,
          snapshot: frozen.value,
          commands: [shellCommand("production-layout-state-reads", script)],
          contractDigest: frozen.value.contractDigest,
          runScoped: true,
        });
        expect(verified, JSON.stringify(verified)).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
      } finally {
        runSandboxedSpy.mockRestore();
        if (previousHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = previousHome;
      }

      const observedOutcome = (value: Awaited<ReturnType<typeof runSandboxed>> | null): Awaited<ReturnType<typeof runSandboxed>> => {
        expect(value, "VerificationEngine did not execute the state-read command").not.toBeNull();
        if (value === null) throw new Error("VerificationEngine did not execute the state-read command");
        return value;
      };
      const completedOutcome = observedOutcome(outcome);
      expect(completedOutcome, JSON.stringify(completedOutcome)).toMatchObject({
        status: "PASS",
        reasonCode: null,
        enforcement: { readConfinement: "sensitive-paths" },
      });
      assertDeniedRows(completedOutcome.stdout, [
        "database",
        "database -wal",
        "database -shm",
        "database -journal",
        "backups directory",
        "backup",
        "backup manifest",
        "capacity",
        "secrets directory",
        "secret",
      ]);
      const rows = new Map(probeRows(completedOutcome.stdout).map((row) => [row.label, row]));
      expect(rows.get("current worktree")).toMatchObject({ status: "0", errno: "OK" });
    } finally {
      controlPlane.close();
    }
  });

  it("P1-15 proves a shell cannot write outside its worktree or scratch", async () => {
    const worktree = tempDir("acp-p1-15-write-worktree-");
    const outside = join(tempDir("acp-p1-15-write-outside-"), "escape.txt");
    const script = `exec ${usablePython3()} -c ${shellQuote(pythonWriteProbe([
      { label: "assigned worktree", path: join(worktree, "inside.txt") },
      { label: "assigned scratch", path: "$TMPDIR/scratch.txt" },
      { label: "outside assigned roots", path: outside },
    ]))}`;
    const outcome = await runSandboxed({
      command: shellCommand("shell-write-confinement", script),
      worktreePath: worktree,
    });
    const rows = new Map(probeRows(outcome.stdout).map((row) => [row.label, row]));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "PASS", reasonCode: null, enforcement: { writeConfinement: true } });
    expect(rows.get("assigned worktree")).toMatchObject({ status: "0", errno: "OK" });
    expect(rows.get("assigned scratch")).toMatchObject({ status: "0", errno: "OK" });
    expect(rows.get("outside assigned roots")).toMatchObject({ status: "1", errno: "EPERM" });
    expect(rows.get("outside assigned roots")?.message).toMatch(/Operation not permitted|Permission denied/);
  });

  it("P1-15 records the kernel refusal when a shell reaches the network", async () => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end("network-ok");
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePort((server.address() as AddressInfo).port));
    });
    try {
      const script = `exec ${usablePython3()} -c ${shellQuote(String.raw`
import errno, socket
try:
    client = socket.socket()
    client.settimeout(2)
    client.connect(("127.0.0.1", ${port}))
    client.close()
    print("network\tlocalhost\t0\tOK\tCONNECTED")
except OSError as error:
    print("network\tlocalhost\t1\t%s\t%s" % (errno.errorcode.get(error.errno, "UNKNOWN"), str(error)))
`)}`;
      const outcome = await runSandboxed({
        command: shellCommand("shell-network-deny", script),
        worktreePath: tempDir("acp-p1-15-network-worktree-"),
      });
      const row = probeRows(outcome.stdout)[0];
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "PASS", reasonCode: null, enforcement: { networkEnforced: true, networkPolicy: "deny" } });
      expect(row).toMatchObject({ kind: "network", label: "localhost", status: "1", errno: "EPERM" });
      expect(row?.message).toMatch(/Operation not permitted|Permission denied/);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("P1-15 refuses a shell fork under RLIMIT_NPROC", async () => {
    const outcome = await runSandboxed({
      command: shellCommand(
        "shell-process-group",
        "/bin/sleep 30 >/dev/null 2>&1 &",
      ),
      worktreePath: tempDir("acp-p1-15-process-worktree-"),
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "FAIL",
      exitCode: 128,
      enforcement: { childContainmentEnforced: true },
    });
    expect(outcome.stderr).toContain("fork: Resource temporarily unavailable");
  });

  it("P1-15 records SIGXCPU when a shell exceeds its CPU budget", async () => {
    const outcome = await runSandboxed({
      command: shellCommand("shell-cpu-limit", "while :; do :; done", { maxCpuSeconds: 1, timeoutSeconds: 10 }),
      worktreePath: tempDir("acp-p1-15-cpu-worktree-"),
    });
    expect(outcome).toMatchObject({
      status: "ERROR",
      signal: "SIGXCPU",
      reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED,
      enforcement: { resourceLimitsEnforced: true },
    });
  });

  it("P1-15 records the observed RSS breach when a shell exceeds its memory budget", async () => {
    const outcome = await runSandboxed({
      command: shellCommand(
        "shell-rss-limit",
        `${usablePython3()} -c 'x=bytearray(128*1024*1024); import time; time.sleep(30)'`,
        { maxMemoryMb: 64, timeoutSeconds: 10 },
      ),
      worktreePath: tempDir("acp-p1-15-rss-worktree-"),
    });
    // Assert the measurement before the reason code. When this fails on a runner, the
    // question is always "what RSS was actually observed" — and `toMatchObject` omits
    // matching fields from its diff, so leading with the reason code hides the number that
    // explains it.
    expect(
      outcome.peakRssMb,
      `peak RSS vs 64MB cap | reasonCode=${outcome.reasonCode ?? "none"} | containmentEnforced=${outcome.enforcement.childContainmentEnforced} | containmentReason=${outcome.enforcement.childContainmentReason ?? "none"} | exit=${outcome.exitCode} signal=${outcome.signal ?? "none"}`,
    ).toBeGreaterThan(64);
    // Whether containment ends up *proven* is host-dependent: a command stopped for
    // exceeding its budget may or may not report a candidate identity first, depending on
    // how fast the kill lands. That is not what this test is about, so it is carried in the
    // message above rather than asserted. What must hold everywhere is the assertion below —
    // the breach is what the refusal names, not the unprovenness it caused.
    expect(outcome).toMatchObject({
      status: "ERROR",
      reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED,
      enforcement: { resourceLimitsEnforced: true, memoryLimit: "observed" },
    });
  });
});
