import * as git from "../../src/git/git.ts";
import { afterAll, expect, it, vi } from "vitest";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";
afterAll(cleanupTempDirs);
it("ACP1187-R1-02: repeated interleaving must not accept feature HEAD as default", async () => {
  const h = makeHarness();
  const { repositoryId } = await registerFixtureProject(h);
  const baseline = h.cp.repositories.byId(repositoryId)!.lastObservedHead;
  gitSync(h.repoPath, ["checkout", "-b", "owner-feature"]);
  writeFiles(h.repoPath, { "README.md": "# owner feature\n" });
  const descendant = commitAll(h.repoPath, "owner feature");
  const readHead = git.tryRevParse;
  const readBranch = git.currentBranch;
  const readClean = git.isClean;
  let headReads = 0, branchReads = 0;
  const invoke = git.git;
  const snapshots = vi.spyOn(git, "git").mockImplementation(async (cwd, args, options) => {
    const result = await invoke(cwd, args, options);
    if (args.includes("status")) {
      expect(args.slice(-5)).toEqual(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"]);
      expect(result.stdout).toContain(`# branch.oid ${descendant}\n`);
      expect(result.stdout).toContain("# branch.head owner-feature\n");
      // Coherent readers see feature B together; moving back to dev cannot relabel that HEAD.
      gitSync(cwd, ["checkout", "dev"]);
    }
    return result;
  });
  const headProbe = vi.spyOn(git, "tryRevParse").mockImplementation(async (cwd, ref) => {
    const head = await readHead(cwd, ref);
    if (++headReads < 3) gitSync(cwd, ["checkout", "dev"]);
    return head;
  });
  const branchProbe = vi.spyOn(git, "currentBranch").mockImplementation(async (cwd) => {
    branchReads++;
    expect(await readHead(cwd, "dev")).toBe(baseline);
    return readBranch(cwd);
  });
  const cleanProbe = vi.spyOn(git, "isClean").mockImplementation(async (cwd) => {
    if (branchReads >= 2) gitSync(cwd, ["checkout", "owner-feature"]);
    return readClean(cwd);
  });
  try {
    const observed = await h.cp.repositories.observe(repositoryId);
    if (headReads > 0) {
      expect(headReads).toBe(3);
      expect(branchReads).toBe(3);
    } else {
      expect(snapshots).toHaveBeenCalledTimes(1);
      expect(branchReads).toBe(0);
    }
    expect(gitSync(h.repoPath, ["rev-parse", "dev"])).toBe(baseline);
    expect(gitSync(h.repoPath, ["rev-parse", "HEAD"])).toBe(headReads > 0 ? descendant : baseline);
    expect(observed).toMatchObject({ lastObservedHead: baseline, driftState: "DRIFTED" });
  } finally { headProbe.mockRestore(); branchProbe.mockRestore(); cleanProbe.mockRestore(); snapshots.mockRestore(); }
});
