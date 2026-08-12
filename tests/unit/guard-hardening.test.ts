import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { symlinkSync } from "node:fs";

import { isoPlus } from "../../src/core/clock.ts";
import { newAssignmentId } from "../../src/core/ids.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  ManagedWriteGuard,
  ReadOperation,
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
} from "../helpers/fixtures.ts";

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
  return { ...core, repo, seeded, guard };
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
      `INSERT INTO assignments (assignment_id, role_key, role, run_id, session_id,
                                session_incarnation, binding_generation, mode, status, created_at)
       VALUES (?, ?, 'BLIND_REVIEWER', ?, ?, 'inc-rev', 1, 'PREFERRED', 'ACTIVE', ?)`,
      [newAssignmentId(), `BLIND_REVIEWER:${seeded.runId}`, seeded.runId, reviewerSession, clock.nowIso()],
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
  it("a worktree held by another run blocks the write", () => {
    const { guard, db, clock, seeded, repo } = setup();
    otherRun(db, clock, seeded.projectId);
    db.run(`UPDATE run_repositories SET worktree_id = 'wt-shared' WHERE run_id = ?`, [seeded.runId]);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, worktree_id, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cw', ?, 'wt-shared', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );

    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CLAIM_WORKTREE_CONFLICT);
  });

  it("a branch held by another run blocks the write", () => {
    const { guard, db, clock, seeded, repo } = setup();
    otherRun(db, clock, seeded.projectId);
    db.run(`UPDATE run_repositories SET work_branch = 'task/T1-x' WHERE run_id = ?`, [seeded.runId]);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb', ?, 'task/T1-x', 'run_other', ?, 1, ?, ?, 'HELD')`,
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
    expect(decision.allowed === false && decision.evidence["source"]).toBe("checked-out branch");
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
    db.run(`UPDATE run_repositories SET work_branch = 'task/T1-x' WHERE run_id = ?`, [seeded.runId]);
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('cb', ?, 'task/T1-x', 'run_other', ?, 1, ?, ?, 'HELD')`,
      [seeded.identity, seeded.sessionId, clock.nowIso(), clock.nowIso()],
    );
    expect(guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") })).allowed).toBe(
      true,
    );
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
    expect([
      ReasonCode.RUN_OWNER_REVOKED,
      ReasonCode.BINDING_REVOKED,
      ReasonCode.WRITE_BINDING_GENERATION_STALE,
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
    ]).toContain(consumed.reasonCode);
  });

  it("a grant is refused once the run leaves ACTIVE", () => {
    const { guard, db, seeded, repo } = setup();
    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);

    db.run(`UPDATE runs SET state = 'BLOCKED' WHERE run_id = ?`, [seeded.runId]);
    const consumed = guard.consume(decision.value.grantId);
    expect(consumed.allowed).toBe(false);
    expect(consumed.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
  });

  it("a grant can be consumed exactly once", () => {
    const { guard, seeded, repo } = setup();
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
    const before = db.get<{ expires_at: string }>(
      `SELECT expires_at FROM resource_claims WHERE run_id = ?`,
      [seeded.runId],
    )!.expires_at;
    // The lease is close to expiry when the write is authorised.
    db.run(`UPDATE resource_claims SET expires_at = ? WHERE run_id = ?`, [
      isoPlus(clock.nowIso(), 2_000),
      seeded.runId,
    ]);

    const decision = guard.evaluate(managedRequest(seeded, { targetPath: join(repo, "src/app.ts") }));
    if (!decision.allowed) throw new Error(decision.message);
    expect(guard.consume(decision.value.grantId).allowed).toBe(true);

    const after = db.get<{ expires_at: string }>(
      `SELECT expires_at FROM resource_claims WHERE run_id = ?`,
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
