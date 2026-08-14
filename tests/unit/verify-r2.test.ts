import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixtureManifest, makeHarness } from "../helpers/harness.ts";
import { applyPassingChange } from "../helpers/harness.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { assertPortableManifest } from "../../src/contracts/manifest.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow } from "../../src/core/errors.ts";
import { ExecutionMode, RunKind, SessionLifecycle } from "../../src/domain/types.ts";
import {
  buildCandidateSnapshot,
  candidateSnapshotDigest,
  verifySnapshotFreshness,
} from "../../src/snapshot/candidate-snapshot.ts";
import {
  __testing as sandboxTesting,
  buildSandboxEnvironment,
  memoryLimitForPlatform,
  runSandboxed,
} from "../../src/verify/sandbox.ts";
import { WorktreeManager } from "../../src/verify/worktree.ts";
import { WorktreeAction, WriteOperation, type ManagedWriteGuard } from "../../src/guard/managed-write-guard.ts";
import type { WorktreeAuthorization } from "../../src/verify/worktree.ts";

afterEach(cleanupTempDirs);

const contract = {
  goal: "verification regression",
  why: "test",
  scope: [],
  nonGoals: [],
  acceptance: ["verified"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const testWorktreeAuthorization = (
  manager: WorktreeManager,
  repositoryPath: string,
  worktreeId: string,
): WorktreeAuthorization => {
  const path = manager.pathFor(worktreeId);
  const guard = {
    authorize: async (_request: unknown, effect: (context: { grant: object }) => Promise<void> | void) => {
      const value = await effect({ grant: {} });
      return allow(ReasonCode.WRITE_ALLOWED, value);
    },
  } as unknown as ManagedWriteGuard;
  const common = {
    guard,
    request: {
      operation: WriteOperation.GIT_WORKTREE,
      repositoryIdentity: "test-repository",
      targetWorktreeId: repositoryPath,
      runId: "test-run",
      sessionId: "test-session",
      bindingGeneration: 1,
    },
  };
  return {
    add: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.ADD } },
    remove: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
    cleanup: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
    prune: { ...common, request: { ...common.request, targetPath: repositoryPath, worktreeAction: WorktreeAction.PRUNE } },
  };
};

type SandboxTest = () => void | Promise<void>;

// Seatbelt is the executable sandbox backend on Darwin. Unsupported hosts must not make these
// platform-specific checks look like passing evidence; the Linux mechanism is asserted below.

/**
 * A python3 that actually runs, resolved on the test side.
 *
 * `/usr/bin/python3` on a GitHub macOS runner is an Xcode shim: it shells out to xcrun,
 * needs `xcodebuild` and a writable cache directory, and the verification sandbox denies
 * both — so a probe pinned to that path fails before reaching the behaviour it tests. The
 * first candidate that answers `--version` is the one embedded into the probe.
 */
const usablePython3 = (): string => {
  for (const candidate of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return "/usr/bin/python3";
};

const sandboxIt = (name: string, fn: SandboxTest): void => {
  if (process.platform === "darwin") it(name, fn);
};

const frozenPinnedCandidate = async (options: {
  manifest?: ReturnType<typeof fixtureManifest>;
  trustClass?: "OWNER_TRUSTED" | "UNTRUSTED";
  baseBranch?: string;
  workBranch?: string;
  beforeRun?: (repositoryPath: string) => void;
} = {}) => {
  const harness = makeHarness();
  options.beforeRun?.(harness.repoPath);
  const manifest = options.manifest ?? fixtureManifest("verify-r2-project");
  const project = harness.cp.projects.register({
    projectId: manifest.projectId,
    name: "verify-r2",
    manifest,
    authorization: harness.cp.manifestAuthorizationForTests(manifest),
  });
  if (!project.allowed) throw new Error(project.message);
  const repository = await harness.cp.repositories.register({
    checkoutPath: harness.repoPath,
    projectId: manifest.projectId,
    repositoryRole: "primary",
    activeManifestDigest: project.value.activeManifestDigest,
    identity: "github:acme/fixture",
    trustClass: options.trustClass,
  });
  if (!repository.allowed) throw new Error(repository.message);
  const created = harness.cp.runs.create({
    projectId: manifest.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract,
    repositories: [{
      repositoryId: repository.value.repositoryId,
      repositoryRole: "primary",
      baseBranch: options.baseBranch ?? "dev",
    }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  applyPassingChange(harness.repoPath, options.workBranch ?? "task/verify-r2");
  const snapshot = await harness.cp.pipeline.freeze(created.value.runId);
  if (!snapshot.allowed) throw new Error(snapshot.message);
  return { harness, manifest, repository: repository.value, run: dispatched.value, snapshot: snapshot.value };
};

describe("round-2 verification isolation and candidate freshness", () => {
  it("#382 freezes the required source commit even when that source branch later advances", async () => {
    const { harness, run, snapshot } = await frozenPinnedCandidate({
      baseBranch: "main",
      workBranch: "release/1.2.3",
      beforeRun: (repositoryPath) => {
        // `main` is the release target, while the release branch is cut from a later
        // `dev` commit. Distinct SHAs make a target-derived source impossible to hide.
        gitSync(repositoryPath, ["branch", "main", "dev"]);
        writeFiles(repositoryPath, { "README.md": "# dev source before release\n" });
        commitAll(repositoryPath, "advance dev before release");
      },
    });
    const frozenRepository = snapshot.repositories[0]!;
    const sourceAtFreeze = gitSync(harness.repoPath, ["rev-parse", "dev"]);
    const frozenDigest = candidateSnapshotDigest(snapshot);

    expect(frozenRepository).toMatchObject({
      baseBranch: "main",
      sourceBranch: "dev",
      sourceHead: sourceAtFreeze,
    });
    expect(frozenRepository.sourceHead).not.toBe(frozenRepository.baseHead);

    gitSync(harness.repoPath, ["checkout", "-q", "dev"]);
    writeFiles(harness.repoPath, { "README.md": "# dev source after release freeze\n" });
    const advancedSourceHead = commitAll(harness.repoPath, "advance dev after release freeze");
    gitSync(harness.repoPath, ["checkout", "-q", "release/1.2.3"]);

    // The frozen SHA is the evidence. A moving source ref is not candidate drift.
    const fresh = await verifySnapshotFreshness(snapshot, [{
      identity: frozenRepository.identity,
      checkoutPath: harness.repoPath,
    }]);
    expect(fresh).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
    expect(snapshot.repositories[0]!.sourceHead).toBe(sourceAtFreeze);
    expect(harness.cp.runs.currentCandidate(run.runId)).toBe(frozenDigest);

    // The source SHA is load-bearing: replacing it would create a different candidate
    // identity, so no PR receipt can silently prove the advanced source instead.
    const rewritten = structuredClone(snapshot);
    rewritten.repositories[0]!.sourceHead = advancedSourceHead;
    expect(candidateSnapshotDigest(rewritten)).not.toBe(frozenDigest);
  });

  it("#160 refuses a weaker caller command even when pin fields are omitted", async () => {
    const { harness, run, snapshot } = await frozenPinnedCandidate();
    const refused = await harness.cp.verification.verify({
      runId: run.runId,
      snapshot,
      commands: [parseVerificationCommand({ id: "verify", argv: ["node", "-e", "process.exit(0)"] })],
      contractDigest: snapshot.contractDigest,
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT });
  });

  it("#161 rejects a worktree id paired with a different checkout", async () => {
    const repo = makeRepo({ "a.txt": "base\n" });
    const candidate = join(tempDir("acp-candidate-"), "candidate");
    gitSync(repo, ["worktree", "add", "--detach", candidate, "HEAD"]);
    const id = readdirSync(join(repo, ".git", "worktrees"))[0]!;

    await expect(
      buildCandidateSnapshot(
        {
          runId: "run_1",
          contractDigest: "sha256:contract",
          repositories: [{
            identity: "github:acme/repo",
            repositoryRole: "primary",
            checkoutPath: repo,
            baseBranch: "dev",
            worktreeId: id,
          }],
        },
        makeHarness().clock,
      ),
    ).rejects.toMatchObject({ reasonCode: ReasonCode.SNAPSHOT_STALE });
  });

  sandboxIt("#162 refuses a cwd symlink that resolves outside the frozen worktree", async () => {
    const repo = makeRepo();
    const outside = tempDir("acp-outside-");
    // A committed symlink is the candidate-controlled path the command would otherwise
    // follow outside its frozen checkout.
    const link = join(repo, "linked");
    symlinkSync(outside, link);
    commitAll(repo, "commit escaping cwd symlink");
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "symlink-cwd", argv: ["node", "-e", "process.exit(0)"], cwd: "linked" }),
      worktreePath: repo,
    });
    expect(outcome).toMatchObject({ status: "ERROR", reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE });
  });

  it("#163 drops an opaque provider token even when a command asks for its name", () => {
    const env = buildSandboxEnvironment(
      parseVerificationCommand({
        id: "env",
        argv: ["node", "-e", "process.exit(0)"],
        envAllowlist: ["PROVIDER_TOKEN", "NODE_ENV"],
      }),
      tempDir("acp-env-"),
      { PROVIDER_TOKEN: "opaque-value-that-is-not-pattern-matched", NODE_ENV: "test" },
    );
    expect(env.PROVIDER_TOKEN).toBeUndefined();
    expect(env.NODE_ENV).toBe("test");
  });

  sandboxIt("#164 fences a detached descendant when RLIMIT_NPROC is unavailable", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "detached.js"),
      `const { spawn } = require('node:child_process');
       // Node's detached POSIX spawn calls setsid(2), so this child gets a new
       // session/process group and would outlive the candidate without the trusted fence.
       const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
       child.once('spawn', () => {
         console.log(JSON.stringify({ childPid: child.pid, spawnError: null }));
         child.unref();
       });
       child.once('error', (error) => {
         console.log(JSON.stringify({ childPid: null, spawnError: error.code ?? null }));
       });`,
    );

    const { outcome, result } = await sandboxTesting.withProcessCountLimitDisabled(async () => {
      const outcome = await runSandboxed({
        command: parseVerificationCommand({
          id: "detached",
          argv: ["node", "detached.js"],
          timeoutSeconds: 2,
        }),
        worktreePath: repo,
      });
      let result: { childPid: number | null; spawnError: string | null } | null = null;
      try {
        result = JSON.parse(outcome.stdout) as { childPid: number | null; spawnError: string | null };
      } catch {
        // The exact sandbox outcome below identifies a wrapper failure before output exists.
      }
      return { outcome, result };
    });

    expect(outcome).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { resourceLimitsEnforced: true, childContainmentEnforced: true },
    });
    expect(result).toMatchObject({ childPid: expect.any(Number), spawnError: null });
    if (result === null || result.childPid === null) return;

    let childIsAlive = false;
    try {
      // 12s, not 1s. The reap is asynchronous, and 40 attempts at 25ms gave the fence one
      // second to finish — enough on an idle machine and not enough on a loaded CI runner.
      // That produced `expected true to be false` on four unrelated branches today, none of
      // which touched the sandbox (#461), and each passed on re-run.
      //
      // This does not weaken the assertion: an unreaped child still fails it, just later. The
      // probe is `sleep 30`, so a fence that never fires is still caught well inside the
      // child's own lifetime. The cost of the old deadline was not a missed defect but a
      // signal nobody could trust — a red build stopped meaning anything, which is worse than
      // a slow one.
      for (let attempt = 0; attempt < 480; attempt += 1) {
        try {
          process.kill(result.childPid, 0);
          childIsAlive = true;
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          childIsAlive = false;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(childIsAlive).toBe(false);
    } finally {
      // A failed containment assertion must not leave the escaped probe behind.
      if (childIsAlive) process.kill(result.childPid, "SIGKILL");
    }
  });

  sandboxIt("#164 tracks a same-process setsid escape after it kills the wrapper", async () => {
    const repo = makeRepo();
    const pidPath = join(repo, "self-detached.pid");
    writeFileSync(
      join(repo, "self-detach.py"),
      `import os, signal, time
os.setsid()
with open(${JSON.stringify(pidPath)}, "w", encoding="ascii") as handle:
    handle.write(str(os.getpid()))
    handle.flush()
for descriptor in (0, 1, 2):
    try:
        os.close(descriptor)
    except OSError:
        pass
os.kill(os.getppid(), signal.SIGKILL)
time.sleep(30)
`,
    );

    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "self-detach",
        argv: [
          "node",
          "-e",
          `process.execve(${JSON.stringify(usablePython3())},[${JSON.stringify(usablePython3())},'self-detach.py'],process.env)`,
        ],
        timeoutSeconds: 3,
      }),
      worktreePath: repo,
    });

    const escapedPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    expect(escapedPid).toBeGreaterThan(0);
    expect(() => process.kill(escapedPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(outcome).toMatchObject({
      status: "ERROR",
      signal: "SIGKILL",
      enforcement: { childContainmentEnforced: true, childContainmentReason: null },
    });
  });

  sandboxIt("#164 refuses a candidate fork under RLIMIT_NPROC", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "detached.js"),
      `const { spawn } = require('node:child_process');
       const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
       child.once('spawn', () => {
         console.log(JSON.stringify({ childPid: child.pid, spawnError: null }));
         child.unref();
       });
       child.once('error', (error) => {
         console.log(JSON.stringify({ childPid: null, spawnError: error.code ?? null }));
       });`,
    );
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "detached",
        argv: ["node", "detached.js"],
        timeoutSeconds: 2,
      }),
      worktreePath: repo,
    });
    let result: { childPid: number | null; spawnError: string | null } | null = null;
    try {
      result = JSON.parse(outcome.stdout) as { childPid: number | null; spawnError: string | null };
    } catch {
      // The exact sandbox outcome below identifies a wrapper failure before output exists.
    }
    expect(outcome).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { resourceLimitsEnforced: true, childContainmentEnforced: true },
    });
    expect(result).toEqual({ childPid: null, spawnError: "EAGAIN" });
  });

  sandboxIt("#164 returns the child-cleanup failure when reaping cannot be proved", async () => {
    const repo = makeRepo();
    const shimDirectory = tempDir("acp-ps-shim-");
    const shim = join(shimDirectory, "ps");
    const observed = join(shimDirectory, "group-reap-observed");
    writeFileSync(
      shim,
      `#!/bin/sh
if [ "$1" = "-o" ] && [ "$2" = "pid=" ] && [ "$3" = "-g" ]; then
  : > ${JSON.stringify(observed)}
  printf '99999\\n'
  exit 0
fi
exec /bin/ps "$@"
`,
    );
    chmodSync(shim, 0o700);

    const previousPath = process.env.PATH;
    try {
      // The process cap deliberately prevents a real escaped child. This makes only the
      // post-run proof unavailable, so the assertion exercises the fail-closed evidence gate.
      process.env.PATH = `${shimDirectory}:${previousPath ?? ""}`;
      const outcome = await runSandboxed({
        command: parseVerificationCommand({ id: "unreaped", argv: ["node", "-e", "process.exit(0)"] }),
        worktreePath: repo,
      });
      expect(existsSync(observed)).toBe(true);
      expect(outcome).toMatchObject({
        status: "ERROR",
        reasonCode: ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED,
        enforcement: {
          childContainmentEnforced: false,
          childContainmentReason: expect.any(String),
        },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  sandboxIt("#166/#233 turns hard CPU exhaustion into a resource-limit error", async () => {
    const repo = makeRepo();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "cpu-limit",
        argv: ["node", "-e", "while(1){}"],
        // The wall-clock budget has to be wide enough that CPU exhaustion always happens
        // first: a busy loop accrues CPU time only as fast as its share of the machine, so a
        // 3s timeout against a 1s CPU limit reports TIMEOUT under load and SIGXCPU when idle.
        // That is a test that depends on the scheduler, not on the limit it names.
        maxCpuSeconds: 1,
        timeoutSeconds: 30,
        maxMemoryMb: 256,
      }),
      worktreePath: repo,
    });
    expect(outcome).toMatchObject({
      status: "ERROR",
      signal: "SIGXCPU",
      reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED,
      enforcement: { resourceLimitsEnforced: true, childContainmentEnforced: true },
    });
  });

  it("#165 treats a deleted frozen base branch as snapshot drift", async () => {
    const repo = makeRepo({ "a.txt": "base\n" });
    gitSync(repo, ["checkout", "-q", "-b", "task/base-delete"]);
    writeFiles(repo, { "a.txt": "candidate\n" });
    commitAll(repo, "candidate");
    const snapshot = await buildCandidateSnapshot(
      {
        runId: "run_1",
        contractDigest: "sha256:contract",
        repositories: [{ identity: "github:acme/repo", repositoryRole: "primary", checkoutPath: repo, baseBranch: "dev" }],
      },
      makeHarness().clock,
    );
    gitSync(repo, ["branch", "-D", "dev"]);
    const fresh = await verifySnapshotFreshness(snapshot, [{ identity: "github:acme/repo", checkoutPath: repo }]);
    expect(fresh).toMatchObject({ allowed: false, reasonCode: ReasonCode.SNAPSHOT_STALE });
  });

  sandboxIt("#348/#349 samples Darwin RSS, kills over-cap memory, and records a normal peak", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "memory.js"),
      `const allocation = Buffer.alloc(512 * 1024 * 1024, 1);
       setInterval(() => { void allocation[0]; }, 1_000);`,
    );
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "memory",
        argv: ["node", "memory.js"],
        maxMemoryMb: 16,
        timeoutSeconds: 5,
      }),
      worktreePath: repo,
    });
    // The observed peak first: it is what explains the reason code, and toMatchObject omits
    // matching fields from its diff, so leading with the reason hides the number.
    expect(
      outcome.peakRssMb,
      `peak RSS vs 16MB cap | reasonCode=${outcome.reasonCode ?? "none"} | containmentEnforced=${outcome.enforcement.childContainmentEnforced} | containmentReason=${outcome.enforcement.childContainmentReason ?? "none"} | exit=${outcome.exitCode} signal=${outcome.signal ?? "none"}`,
    ).toBeGreaterThan(16);
    expect(outcome).toMatchObject({
      status: "ERROR",
      signal: "SIGKILL",
      reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED,
      enforcement: { memoryLimit: "observed", resourceLimitsEnforced: true },
    });
    expect(outcome.peakRssMb).toBeTypeOf("number");
    expect(outcome.peakRssMb).toBeGreaterThan(16);

    const normal = await runSandboxed({
      command: parseVerificationCommand({
        id: "memory-normal",
        argv: ["node", "-e", "setTimeout(() => process.exit(0), 500)"],
        maxMemoryMb: 256,
        timeoutSeconds: 5,
      }),
      worktreePath: repo,
    });
    expect(normal).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { memoryLimit: "observed", resourceLimitsEnforced: true },
    });
    expect(normal.peakRssMb).toBeTypeOf("number");
  });

  it("#313/#348/#349 states the Darwin and Linux memory enforcement split", () => {
    expect(memoryLimitForPlatform("darwin")).toBe("observed");
    expect(memoryLimitForPlatform("linux")).toBe("hard");
  });

  sandboxIt("#167 finishes timeout escalation before returning an outcome", async () => {
    const repo = makeRepo();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "timeout", argv: ["node", "-e", "setInterval(() => {}, 1000)"], timeoutSeconds: 1 }),
      worktreePath: repo,
    });
    expect(["TIMEOUT", "ERROR"]).toContain(outcome.status);
    expect(outcome.reasonCode).not.toBeNull();
  });

  it("#168 rejects a project contract that requests unsupported host allowlisting at schema validation", () => {
    const manifest = fixtureManifest("allowlist-contract");
    manifest.verificationCommands[0]!.network = "allowlist";
    manifest.verificationCommands[0]!.networkAllowlist = ["registry.npmjs.org"];
    expect(assertPortableManifest(manifest)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.INVALID_ARGUMENT,
      message: expect.stringContaining("schema validation"),
    });
  });

  it("#169 chooses the newest exact-head CI result instead of an obsolete failure", async () => {
    const ci = parseVerificationCommand({
      id: "ci",
      argv: ["node", "verify.js"],
      repositoryRole: "primary",
      evidenceMode: "TRUSTED_CI",
    });
    const manifest = fixtureManifest("ci-current-result", {
      verificationProfiles: { simple: ["ci"], standard: ["ci"], guarded: ["ci"] },
      verificationCommands: [ci],
    });
    const { harness, run, snapshot } = await frozenPinnedCandidate({ manifest });
    const repository = snapshot.repositories[0]!;
    harness.cp.verification.attachCi({
      fetch: async () => [
        { commandId: "ci", repositoryIdentity: repository.identity, head: repository.candidateHead, conclusion: "failure", workflowDigest: "sha256:w", creatorIdentity: "trusted", completedAt: "2026-08-12T00:00:00.000Z", nonVacuous: true },
        { commandId: "ci", repositoryIdentity: repository.identity, head: repository.candidateHead, conclusion: "success", workflowDigest: "sha256:w", creatorIdentity: "trusted", completedAt: "2026-08-12T01:00:00.000Z", nonVacuous: true },
      ],
      approvedWorkflowDigests: async () => ["sha256:w"],
      trustedCreators: async () => ["trusted"],
    });
    const verified = await harness.cp.verification.verify({ runId: run.runId, snapshot, commands: [ci], contractDigest: snapshot.contractDigest });
    expect(verified).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
  });

  it("#170/#236 structurally rejects absolute, traversing, and non-identity manifest paths", () => {
    const manifest = fixtureManifest("path-contract");
    manifest.repositories[0]!.remote = "/etc/passwd";
    manifest.repositories[0]!.manifestRoot = "../../outside";
    manifest.ciWorkflows = [{ path: "C:\\private\\ci.yml", checkName: "ci", approvedDigest: null }];
    manifest.verificationCommands[0]!.argv = ["node", "../../outside.js"];
    expect(assertPortableManifest(manifest)).toMatchObject({ allowed: false, reasonCode: ReasonCode.MANIFEST_NOT_PORTABLE });
  });

  it("#171/#235 rejects shell paths and env launcher forms", () => {
    expect(() => parseVerificationCommand({ id: "shell", argv: ["/bin/sh", "-c", "true"] })).toThrow();
    expect(() => parseVerificationCommand({ id: "env-shell", argv: ["/usr/bin/env", "bash", "-c", "true"] })).toThrow();

    // P1-15's filed reproduction, exactly as reported: the old walker returned at the first
    // non-option argument, so `FOO=1` was read as the executable and the `bash` behind it was
    // never examined. Without this case the regression passes against a walker that still has
    // the hole — the two assertions above only cover the forms where the shell is argv[1].
    expect(() => parseVerificationCommand({
      id: "env-assignment-shell",
      argv: ["env", "FOO=1", "bash", "-c", "true"],
    })).toThrow();
    expect(() => parseVerificationCommand({
      id: "env-assignment-shell-abs",
      argv: ["/usr/bin/env", "FOO=1", "BAR=2", "sh", "-c", "true"],
    })).toThrow();
  });

  it("P1-15 decides the allowlist on the resolved binary, not the name it was given", () => {
    // A file *named* `node` whose realpath is `/bin/sh`. The name half of the allowlist used
    // to be satisfied by the basename and the permitted-root half by the target living in
    // `/bin`, so this restored the launcher form P1-15 was filed for — through a symlink
    // rather than an argv shape, which is why the argv-based regressions above miss it.
    const dir = mkdtempSync(join(tmpdir(), "acp-resolved-name-"));
    const disguised = join(dir, "node");
    symlinkSync("/bin/sh", disguised);

    expect(() => parseVerificationCommand({ id: "disguised", argv: [disguised, "-c", "true"] }))
      .toThrow();
    // …while the interpreter the allowlist is actually for still passes.
    expect(() => parseVerificationCommand({ id: "real-node", argv: [process.execPath, "-e", "0"] }))
      .not.toThrow();
  });

  it("#232 refuses a traversal id without deleting the external target", async () => {
    const repo = makeRepo();
    const root = tempDir("acp-worktrees-");
    const outside = tempDir("acp-outside-");
    writeFileSync(join(outside, "sentinel"), "keep");
    const manager = new WorktreeManager(root);
    await expect(manager.create(repo, "HEAD", "../../outside", {})).rejects.toMatchObject({ reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(readdirSync(outside)).toContain("sentinel");
  });

  it("#234 rejects a colliding live worktree instead of destroying its owner", async () => {
    const repo = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-worktrees-"));
    const authorization = testWorktreeAuthorization(manager, repo, "same");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolveEntered) => { enter = resolveEntered; });
    const held = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const first = manager.withWorktree(repo, "HEAD", "same", authorization, async () => {
      enter();
      await held;
    });
    await entered;
    await expect(manager.withWorktree(repo, "HEAD", "same", authorization, async () => undefined)).rejects.toMatchObject({ reasonCode: ReasonCode.CONFLICT });
    release();
    await first;
  });

  it("#237 refuses untrusted and another run's temporary repositories before execution", async () => {
    const { harness, manifest, run, snapshot } = await frozenPinnedCandidate({ trustClass: "UNTRUSTED" });
    const refused = await harness.cp.verification.verify({
      runId: run.runId,
      snapshot,
      commands: manifest.verificationCommands,
      contractDigest: snapshot.contractDigest,
    });
    expect(refused).toEqual({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_REPOSITORY_UNTRUSTED,
      message: "repository is not owner-trusted",
      evidence: {
        runId: run.runId,
        identity: "github:acme/fixture",
        trustClass: "UNTRUSTED",
      },
    });

    const temporaryHarness = makeHarness();
    const temporaryPath = makeRepo();
    const temporary = await temporaryHarness.cp.repositories.registerTemporary(temporaryPath, "other-run");
    if (!temporary.allowed) throw new Error(temporary.message);
    const temporaryRun = temporaryHarness.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.SIMPLE,
      contract,
      repositories: [{ repositoryId: temporary.value.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!temporaryRun.allowed) throw new Error(temporaryRun.message);
    const bootstrapCto = temporaryHarness.cp.sessions.create({ provider: "scripted", model: "temporary-run-owner" });
    temporaryHarness.cp.sessions.transition(bootstrapCto.sessionId, SessionLifecycle.READY, "test bootstrap owner");
    const bound = temporaryHarness.cp.bootstrap.bindBootstrapCto(
      temporaryRun.value.runId,
      bootstrapCto.sessionId,
    );
    if (!bound.allowed) throw new Error(bound.message);
    const dispatched = await temporaryHarness.cp.runs.dispatch(temporaryRun.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const temporarySnapshot = await buildCandidateSnapshot(
      {
        runId: dispatched.value.runId,
        contractDigest: dispatched.value.contractDigest,
        repositories: [{
          identity: temporary.value.identity,
          repositoryRole: "primary",
          checkoutPath: temporaryPath,
          baseBranch: "dev",
          manifestDigest: null,
        }],
      },
      temporaryHarness.clock,
    );
    const crossRun = await temporaryHarness.cp.verification.verify({
      runId: dispatched.value.runId,
      snapshot: temporarySnapshot,
      commands: [parseVerificationCommand({ id: "temporary", argv: ["node", "-e", "0"] })],
      contractDigest: dispatched.value.contractDigest,
      runScoped: true,
    });
    expect(crossRun).toEqual({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      message: "temporary repository is bound to a different run",
      evidence: {
        runId: dispatched.value.runId,
        identity: temporary.value.identity,
        temporaryForRun: "other-run",
      },
    });
  });

  it("#238 throws a typed denial instead of returning one as a candidate snapshot", async () => {
    await expect(
      buildCandidateSnapshot({ runId: "run_1", contractDigest: "sha256:contract", repositories: [] }, makeHarness().clock),
    ).rejects.toMatchObject({ reasonCode: ReasonCode.EVIDENCE_MISSING });
  });
});
