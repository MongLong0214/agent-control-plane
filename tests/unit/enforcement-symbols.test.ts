import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { acpScratchDir } from "../../src/core/scratch-root.ts";

/**
 * The transition gate names an **enforcement locus** per proof — the production symbol whose
 * behaviour that proof is about. Those loci were written as `file:line` until it was pointed out
 * that a line number keeps resolving after the code moves: it points at whatever is there now, so
 * the reference reads as valid while meaning something else. `CONTRIBUTING.md` records the same
 * finding from the #443 sweep, where every recorded line number had drifted.
 *
 * Symbols fail visibly instead — rename one and the search returns nothing. This puts that visible
 * failure in CI, which is the counterexample the rule needs: if a named locus disappears, the build
 * goes red rather than the gate quietly citing a symbol that no longer exists.
 *
 * Enforced from the suite rather than the workflow for the same reason as the release-version check:
 * a command dropped from a workflow list leaves no trace, a deleted test does.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "verify-enforcement-symbols.mjs");
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("the gate's enforcement loci still exist (#512 transition gate)", () => {
  it("passes against the tree as committed", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails when a named locus symbol disappears", () => {
    // The mutation the rule exists for. A copy of the tree with one locus renamed everywhere is
    // exactly what a refactor would produce, and it must not pass quietly.
    const dir = mkdtempSync(join(acpScratchDir("acp-enforcement-symbols-"), "tree"));
    scratch.push(dir);
    cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });

    const target = join(dir, "src", "github", "github-kernel.ts");
    writeFileSync(
      target,
      readFileSync(target, "utf8").replaceAll("dependentMergeBlocked", "dependentMergeGuarded"),
    );

    const result = spawnSync(process.execPath, [join(dir, "scripts", "verify-enforcement-symbols.mjs")], {
      encoding: "utf8",
    });
    expect(result.status, "a renamed enforcement locus passed unnoticed").toBe(1);
    expect(result.stdout).toContain("dependentMergeBlocked");
    expect(result.stdout).toContain("no longer exist");
  });
});
