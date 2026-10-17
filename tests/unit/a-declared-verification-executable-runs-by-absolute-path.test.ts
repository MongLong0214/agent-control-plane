import { chmodSync, existsSync, realpathSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { parseVerificationCommand, resolveVerificationExecutable } from "../../src/contracts/verification-command.ts";
import type * as VerificationCommandModule from "../../src/contracts/verification-command.ts";
import { runSandboxed, verificationLaunchArgv, type SandboxOutcome } from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, commitAll, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import { stableFixtureBinDir, stableFixtureLink } from "../helpers/stable-fixture-executable.ts";

/**
 * The sandbox allocates its scratch under `~/.agent-control-plane/scratch`, read from HOME when the
 * module loads. That is the live daemon's state root, so this file points HOME at a private
 * directory before anything is imported.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-1102-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

/**
 * One resolver answer a test substitutes, consumed by the next call. Every other call reaches the
 * real resolver, so the rest of this file runs against it unchanged.
 */
type Resolution = ReturnType<typeof VerificationCommandModule.resolveVerificationExecutable>;
const resolverOverride = vi.hoisted(() => ({ next: undefined as Resolution | undefined }));
vi.mock("../../src/contracts/verification-command.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof VerificationCommandModule>();
  return {
    ...actual,
    resolveVerificationExecutable: (...args: Parameters<typeof actual.resolveVerificationExecutable>): Resolution => {
      const next = resolverOverride.next;
      resolverOverride.next = undefined;
      return next ?? actual.resolveVerificationExecutable(...args);
    },
  };
});

afterEach(() => {
  resolverOverride.next = undefined;
  cleanupTempDirs();
});
afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});

const sandboxIt = (name: string, fn: () => Promise<void>): void => {
  if (process.platform === "darwin") it(name, fn);
};

const described = (outcome: SandboxOutcome): string =>
  `sandbox ${outcome.status} exit=${outcome.exitCode} reason=${outcome.reasonCode ?? "none"} stdout: ${outcome.stdout.trim().slice(-500)} stderr: ${outcome.stderr.trim().slice(-2_000)}`;

/**
 * The directories the sandbox's PATH and the allowlist's search both consult ahead of the daemon's
 * own PATH. A declared command neither holds is one whose trusted copy this file can place.
 */
const AHEAD_OF_DAEMON_PATH = [dirname(process.execPath), "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/usr/sbin", "/bin", "/sbin"];

/** `pnpm` where the host allows it, else another declared command the host does not hold there. */
const declaredName = (): string => {
  const name = ["pnpm", "tsc", "eslint", "vitest"].find((candidate) =>
    AHEAD_OF_DAEMON_PATH.every((root) => !existsSync(join(root, candidate))),
  );
  if (name === undefined) throw new Error("every declared command is already ahead of the daemon's PATH on this host");
  return name;
};

/** Runs `operation` with `dir` first on the daemon's PATH, where the allowlist finds the trusted tool. */
const withDaemonPath = async <T>(dir: string, operation: () => Promise<T>): Promise<T> => {
  const previous = process.env["PATH"];
  process.env["PATH"] = [dir, previous ?? ""].join(delimiter);
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
};

/**
 * #1102. The sandbox's PATH lists the candidate worktree before the system directories, and every
 * declared executable but `/usr/bin/git` was launched by name through it. A candidate that commits
 * an executable named after a declared command at its root ran in place of the tool the allowlist
 * had approved outside.
 */
describe("a declared verification executable runs by the absolute path the allowlist approved (#1102)", () => {
  sandboxIt("runs the trusted tool, never the candidate's executable of the same name at its root", async () => {
    const name = declaredName();
    const trusted = stableFixtureBinDir({ [name]: "#!/bin/sh\necho trusted-tool\n" });
    const repository = makeRepo();
    stableFixtureLink(join(repository, name), "#!/bin/sh\necho candidate-tool\n");
    commitAll(repository, "a candidate that ships its own declared command");

    const outcome = await withDaemonPath(trusted, () =>
      runSandboxed({
        command: parseVerificationCommand({ id: "shadowed", argv: [name], timeoutSeconds: 30 }),
        worktreePath: repository,
        denyReadPaths: [],
      }),
    );
    expect(outcome.status, described(outcome)).toBe("PASS");
    expect(outcome.stdout, described(outcome)).not.toContain("candidate-tool");
    expect(outcome.stdout.trim(), described(outcome)).toBe("trusted-tool");
  });

  it("launches every declared executable by the absolute path the allowlist approved, symlinks left in place", async () => {
    const repository = makeRepo();
    // Resolved and stat'ed, never executed: no fresh inode reaches exec.
    writeFiles(repository, { "tools/vitest": "#!/bin/sh\nexit 0\n" });
    chmodSync(join(repository, "tools", "vitest"), 0o755);
    const context = { cwd: repository, additionalRoots: [repository] };

    const node = await verificationLaunchArgv(["node", "-e", "process.exit(0)"], context);
    expect(node.allowed).toBe(true);
    const nodeArgv = node.allowed ? node.value : [];
    expect(isAbsolute(nodeArgv[0] ?? "")).toBe(true);
    expect(nodeArgv).toEqual([resolve(dirname(process.execPath), "node"), "-e", "process.exit(0)"]);
    expect(realpathSync(nodeArgv[0] ?? "")).toBe(resolveVerificationExecutable("node", context).resolvedPath);

    const relativeTool = await verificationLaunchArgv(["./tools/vitest", "run"], context);
    expect(relativeTool).toMatchObject({ allowed: true, value: [join(repository, "tools", "vitest"), "run"] });
  });

  it("makes a tool found through a relative entry on the daemon's PATH absolute, never a path for the sandbox to resolve", async () => {
    const name = declaredName();
    const trusted = stableFixtureBinDir({ [name]: "#!/bin/sh\necho trusted-tool\n" });
    const repository = makeRepo();
    const context = { cwd: repository, additionalRoots: [repository] };
    const launched = await withDaemonPath(relative(process.cwd(), trusted), () => verificationLaunchArgv([name], context));
    expect(launched).toMatchObject({ allowed: true, value: [join(trusted, name)] });
  });

  it("refuses a declared executable that no longer leads to the tool the allowlist approved", async () => {
    const repository = makeRepo();
    const context = { cwd: repository, additionalRoots: [repository] };
    const approved = resolveVerificationExecutable("node", context);
    expect(approved.allowed).toBe(true);
    // The allowlist approved one tool; by launch, `node` leads somewhere else.
    resolverOverride.next = { ...approved, resolvedPath: join(repository, "the-approved-tool") };
    const launched = await verificationLaunchArgv(["node", "-e", "process.exit(0)"], context);
    expect(launched.allowed).toBe(false);
    expect(launched.allowed ? "" : launched.message).toContain("no longer leads to the tool the allowlist approved");
  });

  it("refuses an executable the allowlist does not approve, rather than leaving it to the sandbox's PATH", async () => {
    const repository = makeRepo();
    const context = { cwd: repository, additionalRoots: [repository] };
    const launched = await verificationLaunchArgv(["sh", "-c", "exit 0"], context);
    expect(launched.allowed).toBe(false);
    const missing = await verificationLaunchArgv(["pnpm-that-does-not-exist"], context);
    expect(missing.allowed).toBe(false);
  });
});
