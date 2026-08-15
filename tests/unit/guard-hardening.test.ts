import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { symlinkSync } from "node:fs";

import { isoPlus } from "../../src/core/clock.ts";
import { newAssignmentId } from "../../src/core/ids.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { RunState } from "../../src/domain/types.ts";
import { ClaimRegistry } from "../../src/claims/claim-registry.ts";
import { addWorktree, pruneWorktrees } from "../../src/git/git.ts";
import {
  ManagedWriteGuard,
  ReadOperation,
  WorktreeAction,
  WriteOperation,
} from "../../src/guard/managed-write-guard.ts";
import {
  canonical,
  fakeWorkspaceProbe,
  realWorkspaceProbe,
} from "../../src/guard/workspace-probe.ts";
import {
  cleanupTempDirs,
  makeCore,
  makeRepo,
  seedRun,
  tempDir,
  writeFiles,
  transitionSeededRun,
  seedActor,
} from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { WorktreeManager, type WorktreeAuthorization } from "../../src/verify/worktree.ts";

afterAll(cleanupTempDirs);

/**
 * Regressions for the defects an independent GPT-5.6 Sol review found in the first
 * version of the guard. Each test names the class of bypass it closes.
 */
const setup = (options: { probeFailsOnRepo?: boolean; probeErrorsFor?: string[] } = {}) => {
  const core = makeCore();
  const repo = makeRepo();
  const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
  const errorFor = options.probeFailsOnRepo ? [repo] : options.probeErrorsFor;
  const probe = errorFor
    ? fakeWorkspaceProbe([repo], { errorFor })
    : realWorkspaceProbe;
  const guard = new ManagedWriteGuard(core.db, probe, core.audit, core.clock);
  // #358 asks whether an expired row still occupies the coordination slot, which only the
  // registry's acquire path can answer — the guard's evaluate cannot see the unique index.
  const claims = new ClaimRegistry(core.db, core.clock, core.audit, core.bindings);
  return { ...core, repo, seeded, guard, claims };
};

const otherRun = (
  db: ReturnType<typeof makeCore>["db"],
  clock: ReturnType<typeof makeCore>["clock"],
  projectId: string,
) => {
  db.run(
    `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                       contract_digest, created_at)
     VALUES ('run_other', ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'other', 'sha256:c', ?)`,
    [projectId, clock.nowIso()],
  );
};

const ownBranchClaim = (
  db: ReturnType<typeof makeCore>["db"],
  clock: ReturnType<typeof makeCore>["clock"],
  seeded: ReturnType<typeof seedRun>,
  branch = "dev",
) => {
  db.run(
    `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                  owner_session_id, owner_binding_generation, acquired_at,
                                  expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'HELD')`,
    [
      `branch_${seeded.runId.slice(-8)}_${branch.replaceAll("/", "_")}`,
      seeded.identity,
      branch,
      seeded.runId,
      seeded.sessionId,
      seeded.generation,
      clock.nowIso(),
      isoPlus(clock.nowIso(), 3_600_000),
    ],
  );
};

/** Mirrors the durable row the verification engine writes before it creates a tree. */
const recordVerificationTree = (
  db: ReturnType<typeof makeCore>["db"],
  clock: ReturnType<typeof makeCore>["clock"],
  seeded: ReturnType<typeof seedRun>,
  repositoryPath: string,
  treePath: string,
  worktreeId: string,
) => {
  db.run(
    `INSERT INTO verification_worktrees
       (worktree_id, run_id, command_id, candidate_snapshot_digest, repository_identity,
        repository_checkout_path, worktree_path, head, owner_session_id,
        owner_binding_generation, owner_role_key, state, created_at)
     VALUES (?, ?, 'guard-test', 'sha256:guard-test', ?, ?, ?, 'head', ?, ?, ?, 'CREATING', ?)`,
    [
      worktreeId,
      seeded.runId,
      seeded.identity,
      canonical(repositoryPath),
      canonical(treePath),
      seeded.sessionId,
      seeded.generation,
      seeded.roleKey,
      clock.nowIso(),
    ],
  );
};

const managedRequest = (
  seeded: ReturnType<typeof seedRun>,
  over: Partial<Parameters<ManagedWriteGuard["evaluate"]>[0]> = {},
) => ({
  operation: WriteOperation.FILE_MUTATION,
  runId: seeded.runId,
  sessionId: seeded.sessionId,
  bindingGeneration: seeded.generation,
  ...over,
});

describe("guard fails closed on an unanswerable probe", () => {
  it("a git probe error is not evidence that the path is outside a repository", () => {
    const { guard, seeded, repo } = setup({ probeFailsOnRepo: true });
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/app.ts"),
      claimedClassification: "DIRECT",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.PROBE_FAILED);

    // Even with a valid run identity the operation cannot proceed on a failed probe.
    const withRun = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    expect(withRun.reasonCode).toBe(ReasonCode.PROBE_FAILED);
  });

  it("a registered checkout is managed even when git cannot answer", () => {
    // The path is inside the registered repository, so the classification does not
    // depend on the git probe succeeding.
    const { guard, seeded, repo } = setup({ probeErrorsFor: ["/somewhere-else"] });
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "new/file.ts") }));
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_ALLOWED);
  });
});

describe("guard refuses arguments it cannot authorise reliably", () => {
  it("a relative target path is refused rather than resolved against the daemon cwd", () => {
    const { guard, seeded } = setup();
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: "src/app.ts" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it("a file mutation with no target is refused, not treated as DIRECT", () => {
    const { guard, seeded } = setup();
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: null }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it("a remote operation with no repository identity is refused", () => {
    const { guard, seeded } = setup();
    const decision = guard.evaluate(
      managedRequest(seeded, { operation: WriteOperation.GITHUB_PR, repositoryIdentity: null }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it("#356 refuses a path-only claim from burning a remote release without its branch or ref", async () => {
    const { guard, seeded } = setup();
    // `seedRun` gives this run a repository-wide path claim (`.`). Before #356 that
    // unrelated local claim admitted a path-free release and invoked the effect.
    let effectInvoked = false;
    const decision = await guard.authorize({
      operation: WriteOperation.GITHUB_RELEASE,
      repositoryIdentity: seeded.identity,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    }, () => {
      effectInvoked = true;
      return "release attempted";
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(effectInvoked).toBe(false);
  });
});

describe("P0-12 guarded worktree and source fences", () => {
  it("a worker with no live claim cannot obtain a writable verification worktree", async () => {
    const { guard, db, clock, seeded, repo } = setup();
    db.run(`UPDATE resource_claims SET status = 'RELEASED', released_at = ? WHERE run_id = ?`, [
      clock.nowIso(),
      seeded.runId,
    ]);
    const path = join(tempDir("acp-guarded-worktree-"), "candidate");
    let invoked = false;
    const decision = await addWorktree(repo, path, "HEAD", {
      guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        targetPath: path,
        repositoryIdentity: seeded.identity,
        targetBranch: "dev",
        targetWorktreeId: canonical(path),
        worktreeAction: WorktreeAction.ADD,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
        actor: "worker-test",
      },
    });
    invoked = decision.allowed;
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
    expect(invoked).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("routes real verification worktree add, remove, prune, and cleanup through consumed grants", async () => {
    const { guard, audit, db, clock, seeded, repo } = setup();
    const manager = new WorktreeManager(tempDir("acp-guarded-worktrees-"));
    const path = manager.pathFor("real-guarded-worktree");
    recordVerificationTree(db, clock, seeded, repo, path, "real-guarded-worktree");
    const common = {
      guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        repositoryIdentity: seeded.identity,
        targetWorktreeId: canonical(path),
        targetBranch: "dev",
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
        actor: "worktree-test",
      },
    };
    const authorization: WorktreeAuthorization = {
      add: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.ADD } },
      remove: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
      cleanup: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
      prune: { ...common, request: { ...common.request, targetPath: canonical(repo), worktreeAction: WorktreeAction.PRUNE } },
    };

    await manager.create(repo, "HEAD", "real-guarded-worktree", authorization);
    expect(existsSync(path)).toBe(true);
    await manager.destroy(repo, path, authorization);
    expect(existsSync(path)).toBe(false);

    const cleanupPath = manager.pathFor("real-guarded-cleanup");
    mkdirSync(cleanupPath);
    await manager.cleanup(cleanupPath, {
      ...authorization.cleanup!,
      request: {
        ...authorization.cleanup!.request,
        targetPath: cleanupPath,
        targetWorktreeId: cleanupPath,
        worktreeAction: WorktreeAction.CLEANUP,
      },
    });
    expect(existsSync(cleanupPath)).toBe(false);

    const consumed = audit.byKind("MANAGED_WRITE_GUARD_CONSUMED").map((event) => event.evidence);
    const assertConsumed = (targetPath: string, targetWorktreeId = path): void => {
      expect(consumed).toContainEqual(expect.objectContaining({
        operation: WriteOperation.GIT_WORKTREE,
        targetBranch: "dev",
        targetWorktreeId: canonical(targetWorktreeId),
        resolvedPath: canonical(targetPath),
      }));
    };
    assertConsumed(path); // add (and remove, which uses the same canonical target)
    assertConsumed(repo); // prune (executed from source checkout, bound to the disposable tree)
    assertConsumed(cleanupPath, cleanupPath); // local cleanup
    expect(consumed.filter((entry) => entry.operation === WriteOperation.GIT_WORKTREE)).toHaveLength(4);
  });

  it("denies remove, prune, and cleanup when their GIT_WORKTREE guard is refused", async () => {
    const { guard, db, clock, seeded, repo } = setup();
    const manager = new WorktreeManager(tempDir("acp-denied-worktrees-"));
    const path = manager.pathFor("denied-remove");
    recordVerificationTree(db, clock, seeded, repo, path, "denied-remove");
    const common = {
      guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        repositoryIdentity: seeded.identity,
        targetWorktreeId: canonical(path),
        targetBranch: "dev",
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
        actor: "worktree-denial-test",
      },
    };
    const authorization: WorktreeAuthorization = {
      add: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.ADD } },
      remove: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
      cleanup: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
      prune: { ...common, request: { ...common.request, targetPath: canonical(repo), worktreeAction: WorktreeAction.PRUNE } },
    };

    await manager.create(repo, "HEAD", "denied-remove", authorization);
    db.run(`UPDATE resource_claims SET status = 'RELEASED', released_at = ? WHERE run_id = ?`, [
      clock.nowIso(),
      seeded.runId,
    ]);
    await expect(manager.destroy(repo, path, authorization)).rejects.toMatchObject({
      reasonCode: ReasonCode.WRITE_PATH_NOT_CLAIMED,
    });
    expect(existsSync(path)).toBe(true);

    const cleanupPath = manager.pathFor("denied-cleanup");
    mkdirSync(cleanupPath);
    const cleanup = await manager.cleanup(cleanupPath, {
      ...authorization.cleanup!,
      request: {
        ...authorization.cleanup!.request,
        targetPath: cleanupPath,
        targetWorktreeId: cleanupPath,
        worktreeAction: WorktreeAction.CLEANUP,
      },
    });
    expect(cleanup.allowed).toBe(false);
    expect(cleanup.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
    expect(existsSync(cleanupPath)).toBe(true);

    const prune = await pruneWorktrees(repo, authorization.prune);
    expect(prune.allowed).toBe(false);
    expect(prune.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
    expect(existsSync(path)).toBe(true);
  });

  it("denies a GIT_WORKTREE write while a source-read lease is held", () => {
    const { guard, seeded } = setup();
    const lease = guard.acquireSourceReadLease(seeded.runId, [seeded.identity]);
    expect(lease.allowed).toBe(true);
    const path = join(tempDir("acp-source-lease-worktree-"), "candidate");
    const decision = guard.evaluate({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: path,
      repositoryIdentity: seeded.identity,
      targetBranch: "dev",
      targetWorktreeId: path,
      worktreeAction: WorktreeAction.ADD,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SOURCE_READ_LEASE_CONFLICT);
    if (lease.allowed) lease.value.release();
  });

  it("denies a GIT_WORKTREE write when the run is not ACTIVE", () => {
    const { guard, seeded, db } = setup();
    transitionSeededRun(db, seeded.runId, RunState.BLOCKED);
    const path = join(tempDir("acp-inactive-worktree-"), "candidate");
    const decision = guard.evaluate({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: path,
      repositoryIdentity: seeded.identity,
      targetBranch: "dev",
      targetWorktreeId: path,
      worktreeAction: WorktreeAction.ADD,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
  });

  it("treats a detached verification tree as its own exact worktree resource", () => {
    const { guard, db, clock, seeded } = setup();
    const tree = join(tempDir("acp-exact-verification-tree-"), "candidate");
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('other-verification-tree', ?, ?, 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, canonical(tree), seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );

    const decision = guard.evaluate({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: tree,
      targetWorktreeId: tree,
      worktreeAction: WorktreeAction.ADD,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });

    // Deleting the tree-identity comparison in claimConflict makes this admission pass.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_WORKTREE_CONFLICT);
  });

  it("serializes two attempts on the same not-yet-materialized verification tree", async () => {
    const { guard, seeded } = setup();
    const tree = join(tempDir("acp-inflight-verification-tree-"), "candidate");
    const request = {
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: tree,
      targetWorktreeId: tree,
      worktreeAction: WorktreeAction.ADD,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredEffect = new Promise<void>((resolve) => { entered = resolve; });
    const first = guard.authorize(request, async () => {
      entered();
      await held;
    });
    await enteredEffect;

    const second = await guard.authorize(request, () => undefined);
    // Removing target-key serialization lets both pre-materialisation attempts proceed.
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);

    release();
    expect((await first).allowed).toBe(true);
  });

  it("admits a detached verification tree despite another run's branch claim", () => {
    const { guard, db, clock, seeded } = setup();
    const tree = join(tempDir("acp-detached-verification-tree-"), "candidate");
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('other-branch-for-detached-tree', ?, 'task/other', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );

    const decision = guard.evaluate({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: tree,
      targetWorktreeId: tree,
      worktreeAction: WorktreeAction.ADD,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });

    // Restoring the generic null-branch fail-closed check makes this a branch conflict.
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.value.targetWorktreeId).toBe(canonical(tree));
  });

  it("refuses a GIT_WORKTREE request whose effect and disposable-tree identity differ", () => {
    const { guard, seeded } = setup();
    const target = join(tempDir("acp-worktree-effect-target-"), "candidate");
    const claimedTree = join(tempDir("acp-worktree-effect-identity-"), "candidate");
    const decision = guard.evaluate({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: target,
      targetWorktreeId: claimedTree,
      worktreeAction: WorktreeAction.ADD,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH);
  });

  it.each([
    {
      name: "inside another run's checkout",
      target: (repo: string) => join(repo, "src"),
      overlap: "target-within-claimed-worktree",
    },
    {
      name: "around another run's checkout",
      target: (repo: string) => dirname(repo),
      overlap: "claimed-worktree-within-target",
    },
  ])("refuses a GIT_WORKTREE target $name", ({ target, overlap }) => {
    const { guard, db, clock, seeded, repo } = setup();
    const targetPath = target(repo);
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES (?, ?, ?, 'run_other', ?, 1, ?, ?, 'HELD')`,
      [
        `checkout-containment-${overlap}`,
        seeded.identity,
        canonical(repo),
        seeded.sessionId,
        clock.nowIso(),
        isoPlus(clock.nowIso(), 3_600_000),
      ],
    );

    const decision = guard.evaluate({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath,
      targetWorktreeId: targetPath,
      worktreeAction: WorktreeAction.ADD,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });

    // Removing canonical claimed-worktree containment makes this request pass.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_WORKTREE_CONFLICT);
    expect(decision.evidence).toMatchObject({ overlap });
  });

  it("refuses cleanup before it can rmSync a path inside another run's claimed checkout", async () => {
    const { guard, db, clock, seeded, repo } = setup();
    const targetPath = join(repo, "src");
    mkdirSync(targetPath);
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cleanup-checkout-holder', ?, ?, 'run_other', ?, 1, ?, ?, 'HELD')`,
      [
        seeded.identity,
        canonical(repo),
        seeded.sessionId,
        clock.nowIso(),
        isoPlus(clock.nowIso(), 3_600_000),
      ],
    );
    // This manager root deliberately contains the fixture checkout, so the test reaches
    // WorktreeManager.cleanup's real rmSync effect if the guard ever grants it.
    const manager = new WorktreeManager(repo);
    const decision = await manager.cleanup(targetPath, {
      guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        targetPath,
        targetWorktreeId: targetPath,
        worktreeAction: WorktreeAction.CLEANUP,
        repositoryIdentity: seeded.identity,
        targetBranch: null,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      },
    });

    // Deleting the checkout-containment check both admits cleanup and removes `src`.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_WORKTREE_CONFLICT);
    expect(existsSync(targetPath)).toBe(true);
  });

  it("refuses a GIT_WORKTREE cleanup that overlaps another run's declared checkout path", async () => {
    const { guard, db, clock, seeded, repo } = setup();
    const targetPath = join(repo, "src");
    mkdirSync(targetPath);
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, declared_path, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cleanup-path-holder', ?, 'src', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [
        seeded.identity,
        seeded.sessionId,
        clock.nowIso(),
        isoPlus(clock.nowIso(), 3_600_000),
      ],
    );
    const manager = new WorktreeManager(repo);
    const decision = await manager.cleanup(targetPath, {
      guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        targetPath,
        targetWorktreeId: targetPath,
        worktreeAction: WorktreeAction.CLEANUP,
        repositoryIdentity: seeded.identity,
        targetBranch: null,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      },
    });

    // Restoring GIT_WORKTREE's old null relativePath admits the rmSync effect.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
    expect(existsSync(targetPath)).toBe(true);
  });

  it("refuses a checkout-shaped GIT_WORKTREE grant with an arbitrary disposable tree", async () => {
    const { guard, db, clock, seeded, repo } = setup();
    const fakeTree = join(tempDir("acp-arbitrary-prune-tree-"), "fake");
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('arbitrary-prune-checkout-holder', ?, ?, 'run_other', ?, 1, ?, ?, 'HELD')`,
      [
        seeded.identity,
        canonical(repo),
        seeded.sessionId,
        clock.nowIso(),
        isoPlus(clock.nowIso(), 3_600_000),
      ],
    );
    let effectInvoked = false;
    const decision = await guard.authorize({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: repo,
      targetWorktreeId: fakeTree,
      worktreeAction: WorktreeAction.PRUNE,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    }, () => {
      effectInvoked = true;
    });

    // Removing durable lifecycle ownership makes this checkout-shaped request proceed.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH);
    expect(effectInvoked).toBe(false);
  });

  it("refuses a checkout-shaped GIT_WORKTREE effect that is not a prune", () => {
    const { guard, seeded, repo } = setup();
    const fakeTree = join(tempDir("acp-non-prune-checkout-tree-"), "fake");
    const decision = guard.evaluate({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: repo,
      targetWorktreeId: fakeTree,
      worktreeAction: WorktreeAction.ADD,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });

    // Allowing every lifecycle action to use the source checkout makes this pass.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH);
  });

  it("does not settle a missing checkout target as a successful prune", async () => {
    const { guard, db, clock, seeded, repo } = setup();
    const tree = join(tempDir("acp-prune-missing-target-tree-"), "tree");
    recordVerificationTree(db, clock, seeded, repo, tree, "missing-target-tree");
    let effectInvoked = false;
    const decision = await guard.authorize({
      operation: WriteOperation.GIT_WORKTREE,
      targetPath: repo,
      targetWorktreeId: tree,
      worktreeAction: WorktreeAction.PRUNE,
      repositoryIdentity: seeded.identity,
      targetBranch: null,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    }, () => {
      effectInvoked = true;
      rmSync(repo, { recursive: true, force: false });
    });

    // Restoring generic GIT_WORKTREE missing-target success turns this into an allow.
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_EFFECT_FENCE_LOST);
    expect(effectInvoked).toBe(true);
  });

  it.each([
    { declared: "src/app.ts", target: "src", overlap: "claim-under-target" },
    { declared: "src", target: "src/app.ts", overlap: "target-under-claim" },
  ])("refuses canonical path overlap ($declared vs $target)", ({ declared, target, overlap }) => {
    const { guard, db, clock, seeded, repo } = setup();
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, declared_path, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES (?, ?, ?, 'run_other', ?, 1, ?, ?, 'HELD')`,
      [`overlap-${declared}-${target}`, seeded.identity, declared, seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );
    const decision = guard.evaluate(managedRequest(seeded, {
      targetPath: join(repo, target, "..", target.split("/").at(-1)!),
    }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
    expect(decision.evidence).toMatchObject({ overlap });
  });

  it("a worker cannot use its managed identity to write outside the assigned checkout", async () => {
    const { guard, seeded } = setup();
    const outside = join(tempDir("acp-outside-worker-"), "not-assigned.ts");
    let effectInvoked = false;
    const decision = await guard.authorize(
      managedRequest(seeded, {
        targetPath: outside,
        actor: "worker-test",
      }),
      () => {
        effectInvoked = true;
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
    expect(effectInvoked).toBe(false);
  });

  it("a GitHub write consumes its matching branch claim while a different branch remains concurrent", async () => {
    const { guard, db, clock, seeded } = setup();
    ownBranchClaim(db, clock, seeded, "dev");
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('other-feature', ?, 'feature/other', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );
    transitionSeededRun(db, seeded.runId, RunState.READY_FOR_CEO_REVIEW);
    transitionSeededRun(db, seeded.runId, RunState.CEO_APPROVED);
    const finalizer = guard.claimDaemonFinalizerAuthority();
    let mismatchedInvoked = false;
    const mismatched = await guard.authorize({
      operation: WriteOperation.GITHUB_PR,
      repositoryIdentity: seeded.identity,
      targetBranch: "feature/not-held",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
      daemonFinalizerAuthority: finalizer,
    }, () => {
      mismatchedInvoked = true;
    });
    expect(mismatched.allowed).toBe(false);
    expect(mismatched.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
    expect(mismatchedInvoked).toBe(false);

    let invoked = false;
    const decision = await guard.authorize({
      operation: WriteOperation.GITHUB_PR,
      repositoryIdentity: seeded.identity,
      targetBranch: "dev",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
      daemonFinalizerAuthority: finalizer,
      actor: "github-test",
    }, () => {
      invoked = true;
    });
    expect(decision.allowed).toBe(true);
    expect(invoked).toBe(true);
  });
});

describe("guard is role-aware (CP-HI-04)", () => {
  it("a blind reviewer bound to the run cannot mutate the candidate it judges", () => {
    const { guard, db, clock, seeded, repo } = setup();

    const reviewerSession = "ses_reviewer_guard";
    db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, 'inc-rev', 'gpt', 'sol', 'READY', ?, ?)`,
      [reviewerSession, clock.nowIso(), clock.nowIso()],
    );
    db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, run_id, actor_id, session_id,
                                session_incarnation, binding_generation, mode, status, created_at)
       VALUES (?, ?, 'BLIND_REVIEWER', ?, ?, ?, 'inc-rev', 1, 'PREFERRED', 'ACTIVE', ?)`,
      [newAssignmentId(), `BLIND_REVIEWER:${seeded.runId}`, seeded.runId, seedActor(db, "BLIND_REVIEWER"), reviewerSession, clock.nowIso()],
    );

    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/app.ts"),
      runId: seeded.runId,
      sessionId: reviewerSession,
      bindingGeneration: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
  });
});

describe("guard enforces the §23.2 claim rejects, not only exact paths", () => {
  it("#357 blocks a checkout held under its canonical registered worktree path", () => {
    const { guard, db, clock, seeded, repo } = setup();
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cw', ?, ?, 'run_other', ?, 1, ?, ?, 'HELD')`,
      [
        seeded.identity,
        canonical(repo),
        seeded.sessionId,
        clock.nowIso(),
        isoPlus(clock.nowIso(), 3_600_000),
      ],
    );

    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_WORKTREE_CONFLICT);
  });

  it("#357 refuses a caller-chosen worktree label before it can claim a registered checkout", () => {
    const { db, clock, audit, bindings, seeded } = setup();
    const claims = new ClaimRegistry(db, clock, audit, bindings);

    const claimed = claims.acquire({
      runId: seeded.runId,
      ownerSessionId: seeded.sessionId,
      ownerBindingGeneration: seeded.generation,
      ownerRoleKey: seeded.roleKey,
      repositoryIdentity: seeded.identity,
      worktreeId: "custom",
    });

    expect(claimed.allowed).toBe(false);
    expect(claimed.reasonCode).toBe(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH);
    expect(
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM resource_claims WHERE run_id = ? AND worktree_id = 'custom'`,
        [seeded.runId],
      )?.n,
    ).toBe(0);
  });

  it("a branch held by another run blocks the write", () => {
    const { guard, db, clock, seeded, repo } = setup();
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb', ?, 'dev', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );

    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_BRANCH_CONFLICT);
  });

  it("a branch claim still blocks when the writing run declared no branch of its own", () => {
    // The run has no work_branch, so the guard falls back to the branch the checkout is
    // actually on. Without that fallback a run could bypass the claim simply by never
    // declaring one.
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(
      core.db,
      fakeWorkspaceProbe([repo], { branches: { [repo]: "task/T1-x" } }),
      core.audit,
      core.clock,
    );
    otherRun(core.db, core.clock, seeded.projectId);
    core.db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb2', ?, 'task/T1-x', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, core.clock.nowIso(), isoPlus(core.clock.nowIso(), 3_600_000)],
    );

    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/app.ts"),
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_BRANCH_CONFLICT);
    expect(decision.allowed === false && decision.evidence["source"]).toBe(
      "declared or Git-resolved target branch",
    );
  });

  it("a different branch in the same repository is not a conflict", () => {
    // §23.3 — claims are short coordination leases, not repository ownership. Two runs on
    // different branches of one repository must both be able to work.
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(
      core.db,
      fakeWorkspaceProbe([repo], { branches: { [repo]: "task/T2-mine" } }),
      core.audit,
      core.clock,
    );
    otherRun(core.db, core.clock, seeded.projectId);
    core.db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb3', ?, 'task/T1-theirs', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, core.clock.nowIso(), isoPlus(core.clock.nowIso(), 3_600_000)],
    );

    expect(
      guard.evaluate({
        operation: WriteOperation.FILE_MUTATION,
        targetPath: join(repo, "src/app.ts"),
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      }).allowed,
    ).toBe(true);
  });

  it("an expired lease does not block anyone", () => {
    const { guard, db, clock, seeded, repo } = setup();
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb', ?, 'dev', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), clock.nowIso()],
    );
    expect(guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") })).allowed).toBe(
      true,
    );
  });

  it("an expired lease is reclaimable, not just ignorable (#358)", () => {
    // The half the review named and the assertion above cannot make. Ignoring an expired row in
    // `evaluate` is only correct if the row has also stopped occupying the coordination slot:
    // §30.2's partial unique indexes key on status = 'HELD' alone, with no clock. If the guard
    // treats the row as gone while SQLite still reserves it, nobody can write *and* nobody can
    // take the branch — the run holding it cannot even re-acquire.
    //
    // So this asks for the slot rather than for permission. The test above would pass with the
    // occupant still blocking every acquire, which is exactly what the review said about it.
    const { claims, db, clock, seeded } = setup();
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb_expired', ?, 'dev', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), clock.nowIso()],
    );

    const reclaimed = claims.acquire({
      runId: seeded.runId,
      ownerSessionId: seeded.sessionId,
      ownerBindingGeneration: seeded.generation,
      ownerRoleKey: seeded.roleKey,
      repositoryIdentity: seeded.identity,
      branch: "dev",
    });

    expect(
      reclaimed.allowed,
      `the expired row still occupies the branch slot: ${reclaimed.allowed ? "" : reclaimed.reasonCode}`,
    ).toBe(true);
  });
});

describe("guard binds each operation to exactly one repository", () => {
  it("a remote operation cannot borrow authority from a local path in another repository", () => {
    const { guard, seeded, repo } = setup();
    const decision = guard.evaluate({
      operation: WriteOperation.GITHUB_PR,
      // A path inside the participating repository, but a different declared repository.
      targetPath: join(repo, "src/app.ts"),
      repositoryIdentity: "github:acme/unrelated",
      targetBranch: "dev",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
  });

  it("a nested unregistered repository is not authorised under its parent", () => {
    const { guard, seeded, repo } = setup();
    const nested = join(repo, "vendor", "inner");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", nested]);
    writeFiles(nested, { "x.ts": "export const x = 1;\n" });

    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(nested, "x.ts") }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
    expect(String(decision.allowed === false ? decision.message : "")).toContain("work tree");
  });
});

describe("remote writes name and fence their branch or ref (#356)", () => {
  it("allows a release-branch PR while another run's feature branch remains HELD", async () => {
    const { guard, db, clock, seeded } = setup();
    transitionSeededRun(db, seeded.runId, RunState.READY_FOR_CEO_REVIEW);
    transitionSeededRun(db, seeded.runId, RunState.CEO_APPROVED);
    const daemonAuthority = guard.claimDaemonFinalizerAuthority();
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('feature_held', ?, 'feature/theirs', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );
    ownBranchClaim(db, clock, seeded, "release/mine");

    const decision = await guard.authorize({
      operation: WriteOperation.GITHUB_PR,
      repositoryIdentity: seeded.identity,
      targetBranch: "release/mine",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
      daemonFinalizerAuthority: daemonAuthority,
    }, () => "PR written");

    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_ALLOWED);
    expect(
      db.get<{ status: string }>(`SELECT status FROM resource_claims WHERE claim_id = 'feature_held'`)?.status,
    ).toBe("HELD");
  });

  it("serializes concurrent remote writes on the same operation and branch", async () => {
    const { guard, db, clock, seeded } = setup();
    transitionSeededRun(db, seeded.runId, RunState.READY_FOR_CEO_REVIEW);
    transitionSeededRun(db, seeded.runId, RunState.CEO_APPROVED);
    const daemonAuthority = guard.claimDaemonFinalizerAuthority();
    ownBranchClaim(db, clock, seeded, "release/fence");
    const request = {
      operation: WriteOperation.GITHUB_PR,
      repositoryIdentity: seeded.identity,
      targetBranch: "release/fence",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
      daemonFinalizerAuthority: daemonAuthority,
    };

    let enterFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = guard.authorize(request, async () => {
      enterFirst();
      await firstMayFinish;
      return "first";
    });
    await firstEntered;

    let secondEffectInvoked = false;
    const second = await guard.authorize(request, () => {
      secondEffectInvoked = true;
      return "second";
    });
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(secondEffectInvoked).toBe(false);

    releaseFirst();
    expect((await first).reasonCode).toBe(ReasonCode.WRITE_ALLOWED);
  });
});

describe("expired leases and SQLite's HELD index stay coherent (#358)", () => {
  it("expires a stale branch slot before a remote write, leaving the unique slot reclaimable", async () => {
    const { guard, db, clock, seeded } = setup();
    transitionSeededRun(db, seeded.runId, RunState.READY_FOR_CEO_REVIEW);
    transitionSeededRun(db, seeded.runId, RunState.CEO_APPROVED);
    const daemonAuthority = guard.claimDaemonFinalizerAuthority();
    otherRun(db, clock, seeded.projectId);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('expired_dev', ?, 'dev', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), clock.nowIso()],
    );
    ownBranchClaim(db, clock, seeded, "release/live");

    let effectInvoked = false;
    const remote = await guard.authorize({
      operation: WriteOperation.GITHUB_PR,
      repositoryIdentity: seeded.identity,
      targetBranch: "release/live",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
      daemonFinalizerAuthority: daemonAuthority,
    }, () => {
      effectInvoked = true;
      return "remote write";
    });

    expect(remote.allowed).toBe(true);
    expect(effectInvoked).toBe(true);
    expect(
      db.get<{ status: string }>(`SELECT status FROM resource_claims WHERE claim_id = 'expired_dev'`)?.status,
    ).toBe("EXPIRED");
    // This raw insert deliberately exercises the partial unique index. If the guard only
    // filtered on expires_at instead of expiring the row, SQLite would still reject it.
    expect(() =>
      db.run(
        `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                      owner_session_id, owner_binding_generation, acquired_at,
                                      expires_at, status)
         VALUES ('reclaimed_dev', ?, 'dev', ?, ?, ?, ?, ?, 'HELD')`,
        [
          seeded.identity,
          seeded.runId,
          seeded.sessionId,
          seeded.generation,
          clock.nowIso(),
          isoPlus(clock.nowIso(), 3_600_000),
        ],
      ),
    ).not.toThrow();
  });
});

describe("guard grants are fenced, short-lived and single use", () => {
  it("a grant is refused once the binding generation moves", () => {
    const { guard, db, seeded, repo } = setup();
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    // The binding is revoked in the window between authorisation and the write.
    db.run(`UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`, [seeded.roleKey]);

    const consumed = guard.consume(decision.value.grantId);
    expect(consumed.allowed).toBe(false);
    expect(consumed.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
  });

  it("a grant is refused once the run leaves ACTIVE", () => {
    const { guard, db, seeded, repo } = setup();
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);

    // The grant was issued while the run was ACTIVE; the point is what `consume` does once it
    // is not. §29 refuses a raw state edge (#66), so the edge is taken through the authority.
    transitionSeededRun(db, seeded.runId, "BLOCKED");
    const consumed = guard.consume(decision.value.grantId);
    expect(consumed.allowed).toBe(false);
    expect(consumed.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
  });

  it("a grant can be consumed exactly once", () => {
    const { guard, db, clock, seeded, repo } = setup();
    ownBranchClaim(db, clock, seeded);
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);

    expect(guard.consume(decision.value.grantId).allowed).toBe(true);
    const replay = guard.consume(decision.value.grantId);
    expect(replay.allowed).toBe(false);
    expect(replay.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
  });

  it("a grant expires", () => {
    const { guard, clock, seeded, repo } = setup();
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);

    clock.advance(61_000);
    const consumed = guard.consume(decision.value.grantId);
    expect(consumed.allowed).toBe(false);
    expect(consumed.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
  });

  it("a read-only decision issues no consumable grant", () => {
    const { guard, repo } = setup();
    const decision = guard.evaluate({
      operation: ReadOperation.FILE_READ,
      targetPath: join(repo, "README.md"),
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.value.classification).toBe("DIRECT");
    expect(guard.consume(decision.value.grantId).allowed).toBe(false);
  });
});

describe("post-CEO finalization authority (P0-01)", () => {
  it("admits only the daemon's fenced GitHub write after CEO approval and refuses all writes after completion", () => {
    const { guard, db, clock, seeded, repo } = setup();
    ownBranchClaim(db, clock, seeded, "feature/fixture");
    transitionSeededRun(db, seeded.runId, RunState.READY_FOR_CEO_REVIEW);
    // In production ControlPlane claims this opaque value once and hands it only to the
    // daemon finalizer. This direct guard fixture is the narrow unit equivalent.
    const daemonAuthority = guard.claimDaemonFinalizerAuthority();
    const beforeCeo = guard.evaluate(managedRequest(seeded, {
      operation: WriteOperation.PROGRAMMATIC_MERGE,
      repositoryIdentity: seeded.identity,
      targetBranch: "feature/fixture",
      daemonFinalizerAuthority: daemonAuthority,
    }));
    expect(beforeCeo.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);

    transitionSeededRun(db, seeded.runId, RunState.CEO_APPROVED);

    const sourceDenied = guard.evaluate(managedRequest(seeded, {
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/after-ceo.ts"),
    }));
    expect(sourceDenied.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);

    const remoteRequest = managedRequest(seeded, {
      operation: WriteOperation.GITHUB_PR,
      repositoryIdentity: seeded.identity,
      targetBranch: "feature/fixture",
    });
    const unprivileged = guard.evaluate(remoteRequest);
    expect(unprivileged.allowed).toBe(false);
    expect(unprivileged.reasonCode).toBe(ReasonCode.MERGE_AUTHORITY_DENIED);

    const daemonWrite = guard.evaluate({ ...remoteRequest, daemonFinalizerAuthority: daemonAuthority });
    expect(daemonWrite.allowed).toBe(true);

    transitionSeededRun(db, seeded.runId, RunState.MERGING);
    transitionSeededRun(db, seeded.runId, RunState.POST_MERGE_VERIFYING);
    transitionSeededRun(db, seeded.runId, RunState.COMPLETED);
    const completed = guard.evaluate({ ...remoteRequest, daemonFinalizerAuthority: daemonAuthority });
    expect(completed.allowed).toBe(false);
    expect(completed.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
  });
});

describe("daemon finalization capability construction boundary", () => {
  it("does not expose the daemon capability from a production-shaped control plane", () => {
    const fixture = makeHarness({ allowTestEvidenceWriters: false });
    expect(() => fixture.cp.daemonFinalizationAuthorities()).toThrow(/only exposed to an explicitly unlocked fixture/);
  });
});

describe("path canonicalisation", () => {
  it("keeps every character of a missing top-level component", () => {
    // A naive offset slice returns '/efinitely-new/file' here, and the guard would then
    // authorise a different path than the caller writes.
    expect(canonical("/definitely-new-acp/file.ts")).toBe("/definitely-new-acp/file.ts");
    expect(canonical("/private/tmp/acp-nonexistent-x/y/z.ts")).toBe(
      "/private/tmp/acp-nonexistent-x/y/z.ts",
    );
  });
});

describe("the write itself must be fenced by a claim (§23.2, G6)", () => {
  it("refuses to burn a grant when the run holds no live claim at write time", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo, claim: false });
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);

    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);

    const consumed = guard.consume(decision.value.grantId);
    expect(consumed.allowed).toBe(false);
    expect(consumed.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
  });

  it("refuses a claim taken under a superseded owner generation", () => {
    const { guard, db, seeded, repo } = setup();
    db.run(`UPDATE resource_claims SET owner_binding_generation = 0 WHERE run_id = ?`, [seeded.runId]);
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);
    expect(guard.consume(decision.value.grantId).reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
  });

  it("extends the claim lease so it cannot lapse mid-write", () => {
    const { guard, db, seeded, repo, clock } = setup();
    ownBranchClaim(db, clock, seeded);
    const before = db.get<{ expires_at: string }>(
      `SELECT expires_at FROM resource_claims WHERE run_id = ? AND branch = 'dev'`,
      [seeded.runId],
    )!.expires_at;
    // The lease is close to expiry when the write is authorised.
    db.run(`UPDATE resource_claims SET expires_at = ? WHERE run_id = ? AND branch = 'dev'`, [
      isoPlus(clock.nowIso(), 2_000),
      seeded.runId,
    ]);

    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);
    expect(guard.consume(decision.value.grantId).allowed).toBe(true);

    const after = db.get<{ expires_at: string }>(
      `SELECT expires_at FROM resource_claims WHERE run_id = ? AND branch = 'dev'`,
      [seeded.runId],
    )!.expires_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(clock.nowIso()).getTime() + 60_000);
    expect(before).not.toBe(after);
  });
});

describe("a contract write is managed wherever it sits (§4 CP-HI-01, G2)", () => {
  it("refuses a manifest change outside any repository when no run carries it", () => {
    const { guard } = setup();
    for (const operation of [
      WriteOperation.MANIFEST_CHANGE,
      WriteOperation.VERIFICATION_CONTRACT_CHANGE,
    ]) {
      const decision = guard.evaluate({
        operation,
        targetPath: "/tmp/new-project/acp.manifest.json",
        claimedClassification: "DIRECT",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
    }
  });

  it("holds a caller to a managed run it names, even outside a repository", () => {
    const { guard, seeded } = setup();
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: "/tmp/somewhere-else/notes.md",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
      claimedClassification: "DIRECT",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
  });
});

describe("a symlink is resolved before classification (G3)", () => {
  it("classifies a write through a symlink by its destination, even if it does not exist yet", () => {
    const { guard, repo } = setup();
    const outside = tempDir("acp-symlink-");
    const link = join(outside, "note");
    // The destination does not exist yet, so existsSync-based resolution would miss it.
    symlinkSync(join(repo, "src/created-through-link.ts"), link);

    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: link,
      claimedClassification: "DIRECT",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
  });
});

describe("an undeterminable local resource fails closed (G5)", () => {
  it("refuses a git write when another run claims a branch and ours cannot be determined", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    // The probe cannot answer which branch the checkout is on.
    const guard = new ManagedWriteGuard(
      core.db,
      fakeWorkspaceProbe([repo], { branches: {} }),
      core.audit,
      core.clock,
    );
    otherRun(core.db, core.clock, seeded.projectId);
    core.db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb_undet', ?, 'main', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, core.clock.nowIso(), isoPlus(core.clock.nowIso(), 3_600_000)],
    );

    const decision = guard.evaluate({
      operation: WriteOperation.GIT_COMMIT,
      repositoryIdentity: seeded.identity,
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_BRANCH_CONFLICT);
  });
});
