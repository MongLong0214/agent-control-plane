import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isoPlus } from "../../src/core/clock.ts";
import { newAssignmentId } from "../../src/core/ids.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ManagedWriteGuard, WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { realWorkspaceProbe } from "../../src/guard/workspace-probe.ts";
import {
  cleanupTempDirs,
  makeCore,
  makeRepo,
  seedRun,
  tempDir,
} from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const managedRequest = (
  seeded: ReturnType<typeof seedRun>,
  targetPath: string,
): Parameters<ManagedWriteGuard["evaluate"]>[0] => ({
  operation: WriteOperation.FILE_MUTATION,
  targetPath,
  runId: seeded.runId,
  sessionId: seeded.sessionId,
  bindingGeneration: seeded.generation,
});

const addBranchClaim = (
  db: ReturnType<typeof makeCore>["db"],
  clock: ReturnType<typeof makeCore>["clock"],
  seeded: ReturnType<typeof seedRun>,
  claimId: string,
  branch: string,
  expiresAt = isoPlus(clock.nowIso(), 3_600_000),
) => {
  db.run(
    `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                  owner_session_id, owner_binding_generation, acquired_at,
                                  expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'HELD')`,
    [
      claimId,
      seeded.identity,
      branch,
      seeded.runId,
      seeded.sessionId,
      seeded.generation,
      clock.nowIso(),
      expiresAt,
    ],
  );
};

describe("round-two managed-write regressions", () => {
  it("#97 detects an ancestor symlink replacement while the authorised filesystem effect is in flight", async () => {
    const core = makeCore();
    const repo = makeRepo();
    const redirected = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    addBranchClaim(core.db, core.clock, seeded, "claim_dev", "dev");

    const target = join(repo, "src", "app.ts");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(redirected, "src"));
    const decision = await guard.authorize(managedRequest(seeded, target), () => {
      renameSync(join(repo, "src"), join(repo, "src-before-swap"));
      symlinkSync(join(redirected, "src"), join(repo, "src"));
      writeFileSync(target, "redirected write\n");
      return "write attempted";
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_EFFECT_FENCE_LOST);
  });

  it("#131 blocks a managed source mutation while final publication holds its source-read lease", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    addBranchClaim(core.db, core.clock, seeded, "claim_dev", "dev");
    const lease = guard.acquireSourceReadLease(seeded.runId, [seeded.identity]);
    if (!lease.allowed) throw new Error(lease.message);

    const decision = guard.evaluate(managedRequest(seeded, join(repo, "src", "app.ts")));

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SOURCE_READ_LEASE_CONFLICT);
    lease.value.release();
  });

  it("#98 snapshots every authority fact instead of trusting a caller-mutated request or grant", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    const request = managedRequest(seeded, join(repo, "src", "app.ts"));
    const granted = guard.evaluate(request);
    if (!granted.allowed) throw new Error(granted.message);

    const replacementRun = "run_replacement";
    const replacementSession = "ses_replacement";
    const replacementRole = `BOOTSTRAP_CTO:${replacementRun}`;
    core.db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, 'inc-replacement', 'gpt', 'sol', 'READY', ?, ?)`,
      [replacementSession, core.clock.nowIso(), core.clock.nowIso()],
    );
    core.db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, run_id, session_id,
                                session_incarnation, binding_generation, mode, status, created_at)
       VALUES (?, ?, 'BOOTSTRAP_CTO', ?, ?, 'inc-replacement', 1, 'PREFERRED', 'ACTIVE', ?)`,
      [newAssignmentId(), replacementRole, replacementRun, replacementSession, core.clock.nowIso()],
    );
    core.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                         contract_digest, owner_session_id, owner_binding_generation,
                         owner_session_incarnation, owner_role_key, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'replacement',
               'sha256:contract', ?, 1, 'inc-replacement', ?, ?)`,
      [replacementRun, seeded.projectId, replacementSession, replacementRole, core.clock.nowIso()],
    );
    core.db.run(
      `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch)
       VALUES (?, ?, 'primary', 'dev')`,
      [replacementRun, seeded.repositoryId],
    );

    expect(Object.isFrozen(granted.value)).toBe(true);
    expect(Reflect.set(granted.value, "expiresAt", isoPlus(core.clock.nowIso(), 86_400_000))).toBe(false);
    request.runId = replacementRun;
    request.sessionId = replacementSession;
    core.db.run(`UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`, [seeded.roleKey]);

    const consumed = guard.consume(granted.value.grantId);
    expect(consumed.allowed).toBe(false);
    expect(consumed.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
  });

  it("#99 refuses a first project file when no independent-artifact root proves it is DIRECT", () => {
    const core = makeCore();
    const root = tempDir("acp-uninitialised-project-");
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);

    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(root, "src", "index.ts"),
      claimedClassification: "DIRECT",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.DIRECT_WRITE_ROOT_REQUIRED);
  });

  it("#100 binds GIT_BRANCH to the declared branch instead of run_repositories.work_branch", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    core.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                         contract_digest, created_at)
       VALUES ('run_other', ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'other', 'sha256:c', ?)`,
      [seeded.projectId, core.clock.nowIso()],
    );
    core.db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('release_held', ?, 'release', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, core.clock.nowIso(), isoPlus(core.clock.nowIso(), 3_600_000)],
    );
    core.db.run(`UPDATE run_repositories SET work_branch = 'feature' WHERE run_id = ?`, [seeded.runId]);

    const decision = guard.evaluate({
      operation: WriteOperation.GIT_BRANCH,
      repositoryIdentity: seeded.identity,
      targetBranch: "release",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_BRANCH_CONFLICT);
  });

  it("#101 renews the exact branch lease with max(expiry, deadline), not an unrelated longer lease", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    const releaseBefore = isoPlus(core.clock.nowIso(), 120_000);
    const featureBefore = isoPlus(core.clock.nowIso(), 7_200_000);
    addBranchClaim(core.db, core.clock, seeded, "release_own", "release", releaseBefore);
    addBranchClaim(core.db, core.clock, seeded, "feature_own", "feature", featureBefore);

    const granted = guard.evaluate({
      operation: WriteOperation.GIT_BRANCH,
      repositoryIdentity: seeded.identity,
      targetBranch: "release",
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    if (!granted.allowed) throw new Error(granted.message);
    expect(guard.consume(granted.value.grantId).allowed).toBe(true);

    const releaseAfter = core.db.get<{ expires_at: string }>(
      `SELECT expires_at FROM resource_claims WHERE claim_id = 'release_own'`,
    )!.expires_at;
    const featureAfter = core.db.get<{ expires_at: string }>(
      `SELECT expires_at FROM resource_claims WHERE claim_id = 'feature_own'`,
    )!.expires_at;
    expect(new Date(releaseAfter).getTime()).toBeGreaterThan(new Date(releaseBefore).getTime());
    expect(featureAfter).toBe(featureBefore);
  });

  it("#201 retains and revalidates a permitted DIRECT mutation grant", () => {
    const core = makeCore();
    const artifactRoot = tempDir("acp-independent-artifact-");
    const guard = new ManagedWriteGuard(
      core.db,
      realWorkspaceProbe,
      core.audit,
      core.clock,
      { directWriteRoots: [artifactRoot] },
    );

    const granted = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(artifactRoot, "draft.md"),
    });
    expect(granted.allowed).toBe(true);
    if (!granted.allowed) return;
    expect(granted.value.classification).toBe("DIRECT");
    expect(guard.consume(granted.value.grantId).allowed).toBe(true);
  });
});
