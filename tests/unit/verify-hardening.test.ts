import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, ExecutionMode, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { REPAIR_OWNER_APPROVAL_OPERATION } from "../../src/doctor/repair.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { buildCandidateSnapshot, candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import { runSandboxed, sensitiveReadPaths } from "../../src/verify/sandbox.ts";
import { WorktreeManager } from "../../src/verify/worktree.ts";
import { WorktreeAction, WriteOperation, type ManagedWriteGuard } from "../../src/guard/managed-write-guard.ts";
import type { WorktreeAuthorization } from "../../src/verify/worktree.ts";
import { fixtureManifest, makeHarness, TEST_OWNER } from "../helpers/harness.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

const contract = {
  goal: "verification hardening",
  why: "regression coverage",
  scope: [],
  nonGoals: [],
  acceptance: ["all verification invariants hold"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

type SandboxTest = () => void | Promise<void>;

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
      targetWorktreeId: path,
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

const sandboxIt = (name: string, fn: SandboxTest): void => {
  if (process.platform === "darwin") it(name, fn);
};

/** A projectless §17.5 run with a durable candidate snapshot and its own temporary repository. */
const temporaryCandidate = async () => {
  const harness = makeHarness();
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.SIMPLE,
    contract,
  });
  if (!created.allowed) throw new Error(created.message);

  const repository = await harness.cp.repositories.registerTemporary(harness.repoPath, created.value.runId);
  if (!repository.allowed) throw new Error(repository.message);

  const owner = harness.cp.sessions.create({ provider: "scripted", model: "temporary-cto" });
  harness.cp.sessions.transition(owner.sessionId, SessionLifecycle.READY, "test temporary owner");
  const bound = harness.cp.bootstrap.bindBootstrapCto(created.value.runId, owner.sessionId);
  if (!bound.allowed) throw new Error(bound.message);

  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const attached = harness.cp.runs.attachRepository(created.value.runId, {
    repositoryId: repository.value.repositoryId,
    repositoryRole: "primary",
    baseBranch: "dev",
    ownerSessionId: dispatched.value.ownerSessionId!,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
  });
  if (!attached.allowed) throw new Error(attached.message);

  const frozen = await harness.cp.pipeline.freeze(created.value.runId);
  if (!frozen.allowed) throw new Error(frozen.message);

  return { harness, run: dispatched.value, snapshot: frozen.value };
};

/** Two active runs on different branches of one registered repository. */
const concurrentProjectCandidates = async () => {
  const harness = makeHarness();
  const manifest = fixtureManifest("verification-concurrency", {
    verificationProfiles: { simple: ["parallel"], standard: ["parallel"], guarded: ["parallel"] },
    verificationCommands: [{
      id: "parallel",
      argv: ["node", "-e", "setTimeout(() => process.exit(0), 300)"],
      repositoryRole: "primary",
      cwd: ".",
      timeoutSeconds: 5,
      envAllowlist: [],
      network: "deny",
      networkAllowlist: [],
      required: true,
      evidenceMode: "LOCAL_COMMAND",
      maxOutputBytes: 1_048_576,
      maxMemoryMb: 2048,
    }],
  });
  const project = harness.cp.projects.register({
    projectId: manifest.projectId,
    name: "verification concurrency",
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
  });
  if (!repository.allowed) throw new Error(repository.message);

  const createRun = async () => {
    const created = harness.cp.runs.create({
      projectId: manifest.projectId,
      executionMode: ExecutionMode.STANDARD,
      contract,
      repositories: [{ repositoryId: repository.value.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    return dispatched.value;
  };

  const runA = await createRun();
  const runB = await createRun();
  const head = gitSync(harness.repoPath, ["rev-parse", "HEAD"]);
  gitSync(harness.repoPath, ["branch", "task/verify-concurrent-a", head]);
  gitSync(harness.repoPath, ["branch", "task/verify-concurrent-b", head]);
  const snapshotFor = (runId: string, sourceBranch: string | null) => buildCandidateSnapshot({
    runId,
    contractDigest: runA.contractDigest,
    repositories: [{
      identity: repository.value.identity,
      repositoryRole: "primary",
      checkoutPath: repository.value.checkoutPath,
      baseBranch: "dev",
      candidateRef: head,
      sourceBranch,
      sourceHead: sourceBranch ? head : null,
      manifestDigest: project.value.activeManifestDigest,
    }],
  }, harness.clock);
  const storeSnapshot = (snapshot: Awaited<ReturnType<typeof snapshotFor>>) => {
    const digest = candidateSnapshotDigest(snapshot);
    harness.cp.artifacts.put(snapshot.runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, digest);
    harness.cp.runs.promoteCandidate(snapshot.runId, digest);
  };
  return {
    harness,
    manifest,
    repository: repository.value,
    runA,
    runB,
    snapshotFor,
    storeSnapshot,
  };
};

const withPsShim = async <T>(script: string, fn: () => Promise<T>): Promise<T> => {
  const shimDirectory = tempDir("acp-ps-shim-");
  const shim = join(shimDirectory, "ps");
  writeFileSync(shim, script);
  chmodSync(shim, 0o700);

  const previousPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${previousPath ?? ""}`;
  try {
    return await fn();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
};

describe("verification hardening findings", () => {
  it("#365 disables a candidate post-checkout hook before materialising verification input", async () => {
    const repository = makeRepo({ "verify.js": "process.exit(1);\n" });
    const sentinel = join(tempDir("acp-hook-sentinel-"), "post-checkout-ran");
    const hook = join(repository, ".git", "hooks", "post-checkout");
    writeFileSync(
      hook,
      `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nprintf 'process.exit(0);\\n' > verify.js\n`,
    );
    chmodSync(hook, 0o700);

    const manager = new WorktreeManager(tempDir("acp-worktrees-"));
    const authorization = testWorktreeAuthorization(manager, repository, "hook-disabled");
    let materialisationError: unknown = null;
    try {
      await manager.withWorktree(repository, "HEAD", "hook-disabled", authorization, async (worktree) => {
        expect(existsSync(sentinel)).toBe(false);
        expect(readFileSync(join(worktree.path, "verify.js"), "utf8")).toBe("process.exit(1);\n");
      });
    } catch (error) {
      materialisationError = error;
    }
    // With hook suppression deleted, the hook both leaves the sentinel and causes the
    // post-add integrity gate to refuse the mutated worktree before the callback runs.
    expect(materialisationError).toBeNull();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("#366 pins the first §17.5 command set and refuses a later weaker replacement", async () => {
    const { harness, run, snapshot } = await temporaryCandidate();
    const failing = parseVerificationCommand({
      id: "real-suite",
      argv: ["node", "-e", "setTimeout(() => process.exit(1), 300)"],
      timeoutSeconds: 5,
    });
    const first = await harness.cp.verification.verify({
      runId: run.runId,
      snapshot,
      commands: [failing],
      contractDigest: snapshot.contractDigest,
      runScoped: true,
    });
    expect(first).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED });

    const weaker = parseVerificationCommand({
      id: "real-suite",
      argv: ["node", "-e", "setTimeout(() => process.exit(0), 300)"],
      timeoutSeconds: 5,
    });
    const replaced = await harness.cp.verification.verify({
      runId: run.runId,
      snapshot,
      commands: [weaker],
      contractDigest: snapshot.contractDigest,
      runScoped: true,
    });
    expect(replaced).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
    });

    expect(() =>
      harness.cp.db.run(
        `UPDATE runs
            SET pinned_run_scoped_commands_digest = ?, pinned_run_scoped_commands_json = ?
          WHERE run_id = ?`,
        ["sha256:replacement", "[]", run.runId],
      ),
    ).toThrow(/PINNED_RUN_SCOPED_COMMANDS_IMMUTABLE/);
  });

  it("lets different-branch verifications obtain distinct disposable worktrees while a checkout claim is held", async () => {
    const { harness, manifest, repository, runA, runB, snapshotFor, storeSnapshot } = await concurrentProjectCandidates();
    const claim = harness.cp.claims.acquire({
      runId: runA.runId,
      ownerSessionId: runA.ownerSessionId!,
      ownerBindingGeneration: runA.ownerBindingGeneration!,
      ownerRoleKey: runA.ownerRoleKey!,
      repositoryIdentity: repository.identity,
      branch: "task/verify-concurrent-a",
      // The checkout remains the only worktree identity ClaimRegistry accepts. It must
      // not make a distinct disposable verification tree appear to be this checkout.
      worktreeId: repository.checkoutPath,
    });
    expect(claim.allowed).toBe(true);
    const secondClaim = harness.cp.claims.acquire({
      runId: runB.runId,
      ownerSessionId: runB.ownerSessionId!,
      ownerBindingGeneration: runB.ownerBindingGeneration!,
      ownerRoleKey: runB.ownerRoleKey!,
      repositoryIdentity: repository.identity,
      branch: "task/verify-concurrent-b",
    });
    expect(secondClaim.allowed).toBe(true);

    const [snapshotA, snapshotB] = await Promise.all([
      snapshotFor(runA.runId, "task/verify-concurrent-a"),
      snapshotFor(runB.runId, "task/verify-concurrent-b"),
    ]);
    storeSnapshot(snapshotA);
    storeSnapshot(snapshotB);
    const command = parseVerificationCommand(manifest.verificationCommands[0]!);
    const results = await Promise.allSettled([
      harness.cp.verification.verify({
        runId: runA.runId,
        snapshot: snapshotA,
        commands: [command],
        contractDigest: runA.contractDigest,
      }),
      harness.cp.verification.verify({
        runId: runB.runId,
        snapshot: snapshotB,
        commands: [command],
        contractDigest: runB.contractDigest,
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ allowed: true }) }),
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ allowed: true }) }),
    ]);
  });

  it("lets a detached verification obtain a tree while another run holds a branch claim", async () => {
    const { harness, manifest, repository, runA, runB, snapshotFor, storeSnapshot } = await concurrentProjectCandidates();
    const held = harness.cp.claims.acquire({
      runId: runA.runId,
      ownerSessionId: runA.ownerSessionId!,
      ownerBindingGeneration: runA.ownerBindingGeneration!,
      ownerRoleKey: runA.ownerRoleKey!,
      repositoryIdentity: repository.identity,
      branch: "task/other-run",
    });
    expect(held.allowed).toBe(true);

    const detached = await snapshotFor(runB.runId, null);
    expect(detached.repositories[0]?.sourceBranch).toBeNull();
    storeSnapshot(detached);
    const create = vi.spyOn(harness.cp.worktrees, "create");
    const result = await harness.cp.verification.verify({
      runId: runB.runId,
      snapshot: detached,
      commands: [parseVerificationCommand(manifest.verificationCommands[0]!)],
      contractDigest: runB.contractDigest,
    });

    // Restoring null-branch-as-undeterminable makes guard admission fail before create.
    expect(result.allowed).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps a live verification worktree through an ACTIVE -> BLOCKED owner transition", async () => {
    const { harness, run, snapshot } = await temporaryCandidate();
    const orphanId = "verification-orphan-before-repair";
    const orphanPath = harness.cp.worktrees.pathFor(orphanId);
    gitSync(harness.repoPath, [
      "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", orphanPath, "HEAD",
    ]);

    let releaseCreate!: () => void;
    const createPaused = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createdResolve!: (worktree: { worktreeId: string; path: string }) => void;
    const created = new Promise<{ worktreeId: string; path: string }>((resolve) => { createdResolve = resolve; });
    const realCreate = harness.cp.worktrees.create.bind(harness.cp.worktrees);
    vi.spyOn(harness.cp.worktrees, "create").mockImplementation(async (...args) => {
      const worktree = await realCreate(...args);
      createdResolve(worktree);
      await createPaused;
      return worktree;
    });

    const verification = harness.cp.verification.verify({
      runId: run.runId,
      snapshot,
      commands: [parseVerificationCommand({
        id: "live-record",
        argv: ["node", "-e", "setTimeout(() => process.exit(0), 250)"],
        timeoutSeconds: 5,
      })],
      contractDigest: snapshot.contractDigest,
      runScoped: true,
    });
    let ownerPaused = false;

    try {
      const worktree = await created;
      const durable = harness.cp.db.get<{
        state: string;
        worktree_path: string;
        owner_session_id: string;
        repository_identity: string;
      }>(
        `SELECT state, worktree_path, owner_session_id, repository_identity
           FROM verification_worktrees WHERE worktree_id = ?`,
        [worktree.worktreeId],
      );
      expect(durable).toMatchObject({ state: "CREATING", worktree_path: worktree.path, owner_session_id: run.ownerSessionId });

      const blocked = harness.cp.runs.transition(
        run.runId,
        RunState.BLOCKED,
        "owner pauses while the verification tree is still live",
      );
      expect(blocked).toMatchObject({ allowed: true });
      if (!blocked.allowed) return;
      expect(blocked.value.state).toBe(RunState.BLOCKED);
      ownerPaused = true;

      const approval = {
        runId: null,
        // Non-run operation, so there is no candidate to bind (ingress-guard.ts:41).
        candidateSnapshotDigest: null,
        operation: REPAIR_OWNER_APPROVAL_OPERATION,
        parameters: { operationId: "prune_orphan_worktrees", parameters: {}, dryRun: false },
        idempotencyKey: "repair-live-record",
        approved: true,
      };
      const ingress = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
        cli: { allowedActors: [TEST_OWNER.actor] },
      });
      const admitted = ingress.admitOwnerApproval({
        channel: TEST_OWNER.channel,
        actor: TEST_OWNER.actor,
        nonce: `repair:${digestOf(approval)}`,
        payload: ownerApprovalPayload(approval),
      }, approval);
      expect(admitted.allowed).toBe(true);
      if (!admitted.allowed) return;

      const repaired = await harness.cp.repair.execute({
        operationId: "prune_orphan_worktrees",
        parameters: {},
        authorizedBy: "OWNER",
        ownerApproval: admitted.value,
        dryRun: false,
      });
      expect(repaired.allowed).toBe(true);
      if (!repaired.allowed) return;
      expect(repaired.value.changes).toBe(1);
      expect(repaired.value.preconditionsChecked[0]?.evidence).toMatchObject({
        liveWorktreeIdsByRepository: {
          [durable!.repository_identity]: expect.arrayContaining([worktree.worktreeId]),
        },
        candidates: [{ worktreeId: orphanId }],
      });
      expect(existsSync(worktree.path)).toBe(true);
      expect(existsSync(orphanPath)).toBe(false);
    } finally {
      if (ownerPaused) {
        const resumed = harness.cp.runs.transition(
          run.runId,
          RunState.ACTIVE,
          "owner resumes so verification can perform its guarded teardown",
        );
        if (!resumed.allowed) throw new Error(resumed.message);
      }
      releaseCreate();
    }

    await verification;
    expect(harness.cp.db.get<{ state: string }>(
      "SELECT state FROM verification_worktrees WHERE worktree_id = (SELECT worktree_id FROM verification_worktrees ORDER BY created_at DESC LIMIT 1)",
    )?.state).toBe("DESTROYED");
  });

  sandboxIt("#367 accepts a clean immediately exiting command when it obtains an RSS sample", async () => {
    const repository = makeRepo();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "immediate", argv: ["node", "-e", "process.exit(0)"] }),
      worktreePath: repository,
    });
    expect(outcome).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { memoryLimit: "observed", resourceLimitsEnforced: true, childContainmentEnforced: true },
    });
    expect(outcome.peakRssMb).toBeTypeOf("number");
  });

  sandboxIt("#367 treats recorded RSS as sufficient when the leader identity races away", async () => {
    const repository = makeRepo();
    const failLeaderIdentityOnce = join(tempDir("acp-ps-lstart-once-"), "failed");
    const outcome = await withPsShim(
      `#!/bin/sh
if [ "$1" = "-o" ] && [ "$2" = "lstart=" ] && [ ! -e ${JSON.stringify(failLeaderIdentityOnce)} ]; then
  : > ${JSON.stringify(failLeaderIdentityOnce)}
  exit 1
fi
exec /bin/ps "$@"
`,
      () => runSandboxed({
        command: parseVerificationCommand({
          id: "identity-race",
          // Under a parallel full-suite run, leave enough time for the RSS sampler to
          // observe the group after the deliberately failed lstart probe.
          argv: ["node", "-e", "setTimeout(() => process.exit(0), 1500)"],
          timeoutSeconds: 5,
        }),
        worktreePath: repository,
      }),
    );
    expect(outcome).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { memoryLimit: "observed", resourceLimitsEnforced: true, childContainmentEnforced: true },
    });
    expect(outcome.peakRssMb).toBeTypeOf("number");
  });

  sandboxIt("#367 still refuses a passing command when no RSS sample exists", async () => {
    const repository = makeRepo();
    const outcome = await withPsShim(
      `#!/bin/sh
if [ "$1" = "-o" ] && [ "$2" = "rss=" ] && [ "$3" = "-g" ]; then
  exit 1
fi
exec /bin/ps "$@"
`,
      () => runSandboxed({
        command: parseVerificationCommand({
          id: "missing-rss",
          argv: ["node", "-e", "setTimeout(() => process.exit(0), 300)"],
          timeoutSeconds: 5,
        }),
        worktreePath: repository,
      }),
    );
    expect(outcome).toMatchObject({
      status: "ERROR",
      reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE,
      peakRssMb: null,
      enforcement: { memoryLimit: "none", resourceLimitsEnforced: false },
    });
  });

  it("#368 rejects optional verification commands so every reported input is authoritative", () => {
    expect(() =>
      parseVerificationCommand({
        id: "optional-check",
        argv: ["node", "-e", "process.exit(0)"],
        required: false,
      }),
    ).toThrow();
  });

  it("#369 refuses a candidate snapshot that assigns two identities to one repository role", async () => {
    const first = makeRepo();
    const second = makeRepo();
    await expect(
      buildCandidateSnapshot(
        {
          runId: "run_duplicate_role",
          contractDigest: "sha256:contract",
          repositories: [
            { identity: "github:acme/one", repositoryRole: "primary", checkoutPath: first, baseBranch: "dev" },
            { identity: "github:acme/two", repositoryRole: "primary", checkoutPath: second, baseBranch: "dev" },
          ],
        },
        makeHarness().clock,
      ),
    ).rejects.toMatchObject({ reasonCode: ReasonCode.VERIFICATION_GAP });
  });

  it("#369 refuses a duplicate role even when a forged snapshot bypasses construction", async () => {
    const { harness, run, snapshot } = await temporaryCandidate();
    const repository = snapshot.repositories[0]!;
    const forged = {
      ...snapshot,
      repositories: [repository, { ...repository }],
    };
    const refused = await harness.cp.verification.verify({
      runId: run.runId,
      snapshot: forged,
      commands: [parseVerificationCommand({ id: "single-role", argv: ["node", "-e", "process.exit(0)"] })],
      contractDigest: snapshot.contractDigest,
      runScoped: true,
    });
    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: {
        duplicateRoles: [{ repositoryRole: "primary", identities: [repository.identity] }],
      },
    });
  });

  sandboxIt("#370 denies an XDG Git credential read at a configured host home", async () => {
    const repository = makeRepo();
    const hostHome = tempDir("acp-host-home-");
    const credential = join(hostHome, ".config", "git", "credentials");
    mkdirSync(join(hostHome, ".config", "git"), { recursive: true });
    writeFileSync(credential, "machine example.invalid login test password test\n");

    const previousHome = process.env.HOME;
    process.env.HOME = hostHome;
    let outcome;
    try {
      outcome = await runSandboxed({
        command: parseVerificationCommand({
          id: "read-git-credential",
          argv: ["node", "-e", `require('node:fs').readFileSync(${JSON.stringify(credential)})`],
        }),
        worktreePath: repository,
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    expect(outcome).toMatchObject({ status: "FAIL", exitCode: 1 });
    expect(`${outcome.stdout}\n${outcome.stderr}`).toMatch(/EACCES|EPERM/);
    // The sandbox receives a scrubbed HOME, so userInfo().homedir() is also denied by
    // the independently derived passwd-home path rather than relying on this override.
    expect(sensitiveReadPaths([])).toContain(join(homedir(), ".config", "git", "credentials"));
  });
});
