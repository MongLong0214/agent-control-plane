import { afterAll, describe, expect, it } from "vitest";
import { ManagedWriteGuard, WorktreeAction, WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { fakeWorkspaceProbe } from "../../src/guard/workspace-probe.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Review V52-R1-04 — retirement keeps a repository row as history and lets a replacement reuse its
 * identity at another checkout. Current authority is the identity's unretired row; historical
 * authority, a run bound to the old row, still resolves by repository id.
 */
describe("V52-R1-04 retired repository history never controls current write-guard authority", () => {
  const seeded = () => {
    const c = makeCore();
    const old = tempDir("v52-retired-repo-");
    const active = tempDir("v52-replacement-repo-");
    c.db.run(`INSERT INTO repositories(repository_id,identity,checkout_path,created_at,retired_at) VALUES ('old','github:acme/reuse',?,?,?)`, [old, c.clock.nowIso(), c.clock.nowIso()]);
    c.db.run(`INSERT INTO repositories(repository_id,identity,checkout_path,created_at) VALUES ('new','github:acme/reuse',?,?)`, [active, c.clock.nowIso()]);
    const guard = new ManagedWriteGuard(c.db, fakeWorkspaceProbe([old, active]), c.audit, c.clock);
    return { c, old, active, guard };
  };
  const repair = (authority: ReturnType<ManagedWriteGuard["claimRepairWorktreeAuthority"]>, path: string) => ({
    operation: WriteOperation.GIT_WORKTREE,
    repositoryIdentity: "github:acme/reuse",
    targetWorktreeId: path,
    targetPath: path,
    worktreeAction: WorktreeAction.PRUNE,
    actor: "doctor-repair",
    claimedClassification: "MANAGED" as const,
    repairWorktreeAuthority: authority,
  });

  it("repairs the active replacement checkout and refuses the retired one", () => {
    const { c, old, active, guard } = seeded();
    const authority = guard.claimRepairWorktreeAuthority();
    const current = guard.evaluate(repair(authority, active));
    expect(current.allowed, JSON.stringify(current)).toBe(true);
    const retired = guard.evaluate(repair(authority, old));
    expect(retired.allowed).toBe(false);
    expect(retired.reasonCode).toBe("WRITE_TARGET_OUTSIDE_RUN_SCOPE");
    c.db.close();
  });

  it("resolves a run's own repository by id, and any other grant by the active row", () => {
    const { c, old, active, guard } = seeded();
    const relative = (grant: { runId: string | null; resolvedPath: string }) =>
      (guard as unknown as { relativePath(g: Record<string, unknown>): string | null }).relativePath({
        repositoryIdentity: "github:acme/reuse",
        assignedWorktreeId: null,
        ...grant,
      });
    expect(relative({ runId: null, resolvedPath: `${active}/src/a.ts` })).toBe("src/a.ts");
    expect(relative({ runId: null, resolvedPath: `${old}/src/a.ts` })).toBeNull();
    c.db.run(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
                VALUES ('run_history', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED', 'history', 'sha256:contract', ?)`, [c.clock.nowIso()]);
    c.db.run(`INSERT INTO run_repositories(run_id,repository_id,repository_role,base_branch) VALUES ('run_history','old','primary','dev')`);
    expect(relative({ runId: "run_history", resolvedPath: `${old}/src/a.ts` })).toBe("src/a.ts");
    expect(relative({ runId: "run_history", resolvedPath: `${active}/src/a.ts` })).toBeNull();
    c.db.close();
  });
});
