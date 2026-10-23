import * as git from "../../src/git/git.ts";
import { afterAll, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { rmSync, utimesSync } from "node:fs";
import { cleanupTempDirs, gitSync } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";
afterAll(cleanupTempDirs);
it("ACP1187-R1-02: porcelain status must not certify a head that never belonged to dev", async () => {
  const h = makeHarness();
  const { repositoryId } = await registerFixtureProject(h);
  const baseline = h.cp.repositories.byId(repositoryId)!.lastObservedHead;
  gitSync(h.repoPath, ["checkout", "-b", "owner-feature"]);
  gitSync(h.repoPath, ["commit", "--allow-empty", "-m", "feature-only empty descendant"]);
  const descendant = gitSync(h.repoPath, ["rev-parse", "HEAD"]);
  const invoke = git.git;
  const observations: string[] = [];
  const fifo = join(h.repoPath, ".git", "info", "attributes");
  const probe = vi.spyOn(git, "git").mockImplementation(async (cwd, args, options) => {
    if (!args.includes("status")) return invoke(cwd, args, options);
    gitSync(cwd, ["checkout", "dev"]);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(cwd, "README.md"), later, later);
    execFileSync("mkfifo", [fifo], { timeout: 5000 });
    // Pause the real status during index refresh, after its branch-name read and before
    // its HEAD read. Only timing is controlled: Git produces all returned stdout itself.
    const moving = promisify(execFile)("python3", ["-c", `
import os, subprocess, sys
fd = os.open(sys.argv[1], os.O_WRONLY)
os.unlink(sys.argv[1])
try:
    subprocess.run(['git','-C',sys.argv[2], 'checkout','owner-feature'],check=True,timeout=5,capture_output=True)
finally:
    os.close(fd)
`, fifo, cwd], { timeout: 10_000 });
    const [result] = await Promise.all([invoke(cwd, args, options), moving]);
    observations.push(result.stdout);
    return result;
  });
  try {
    const observed = await h.cp.repositories.observe(repositoryId);
    // One status read is enough: its branch ref no longer names its commit, so the observation is
    // incoherent and nothing is re-read or acknowledged (#1187 r3 closure).
    expect(observations.length).toBeGreaterThanOrEqual(1);
    for (const output of observations) expect(output).toBe(`# branch.oid ${descendant}\n# branch.head dev\n`);
    expect(gitSync(h.repoPath, ["rev-parse", "dev"])).toBe(baseline);
    expect(observed?.lastObservedHead).toBe(baseline);
  } finally { probe.mockRestore(); rmSync(fifo, { force: true }); }
});
