import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { acpScratchDir } from "../../src/core/scratch-root.ts";

/**
 * `scripts/verify-release-version.mjs` is enforced from here rather than from the CI workflow.
 *
 * Not by preference — modifying `.github/workflows/ci.yml` needs a `workflow` token scope this
 * host does not have (#512). Running it from the suite turns out to be the better place anyway:
 * the workflow runs a list of commands, and a command silently dropped from that list leaves no
 * trace, whereas a deleted test is a deleted test.
 *
 * The script is executed rather than reimplemented. A test that recomputed the comparison would
 * pass while the script it stands for was broken — it would be testing this file.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "verify-release-version.mjs");
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Runs the check against a throwaway copy of the two files it reads. */
const runAgainst = (edit: (files: { packageJson: string; changelog: string }) => {
  packageJson?: string;
  changelog?: string;
}) => {
  const dir = mkdtempSync(join(acpScratchDir("acp-release-version-"), "tree"));
  scratch.push(dir);
  cpSync(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });
  const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const edited = edit({ packageJson, changelog });
  writeFileSync(join(dir, "package.json"), edited.packageJson ?? packageJson);
  writeFileSync(join(dir, "CHANGELOG.md"), edited.changelog ?? changelog);
  return spawnSync(process.execPath, [join(dir, "scripts", "verify-release-version.mjs")], {
    encoding: "utf8",
  });
};

describe("the repository states one version, in one place, that agrees with itself (#516)", () => {
  it("passes on the tree as committed", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails when package.json and the changelog disagree", () => {
    // The condition that actually existed: package.json said 1.3.0 from the commit that created
    // it while everything else said v1.0.0, and nothing compared them, so nothing complained.
    const result = runAgainst(({ packageJson }) => ({
      packageJson: packageJson.replace(/"version": "[^"]+"/, '"version": "9.9.9"'),
    }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("state different versions");
  });

  it("fails when the changelog declares no version at all", () => {
    // Otherwise "no versions recorded" would read as "nothing disagrees" — a check that passes
    // when it cannot see its subject (CP-HI-08).
    const result = runAgainst(({ changelog }) => ({
      changelog: changelog.replace(/^## \d+\.\d+\.\d+/m, "## Unreleased"),
    }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("declares no version heading");
  });

  it("fails when the changelog is not ordered newest first", () => {
    // The agreement above is only meaningful if the first heading really is the newest. Without
    // this, an unordered file would have package.json agreeing with an arbitrary past release.
    const result = runAgainst(({ changelog }) => ({
      changelog: changelog.replace(/^## (\d+\.\d+\.\d+)/m, "## $1\n\nplaceholder\n\n## 2.0.0"),
    }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not in descending version order");
  });
});
