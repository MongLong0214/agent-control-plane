import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { acpScratchDir } from "../../src/core/scratch-root.ts";

/**
 * Four adapter options were lost one at a time because `adapters:` replaces what `ControlPlane`
 * builds. `adapterOptions:` makes that class of defect impossible rather than visible, and this
 * keeps the acceptance on that side of the line.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "verify-acceptance-adapter-source.mjs");
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("the acceptance overrides adapter options rather than replacing adapters (#552)", () => {
  it("passes against the tree as committed", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails if the acceptance goes back to constructing real adapters", () => {
    const dir = mkdtempSync(join(acpScratchDir("acp-adapter-source-"), "tree"));
    scratch.push(dir);
    cpSync(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });
    cpSync(join(repoRoot, "tests", "e2e"), join(dir, "tests", "e2e"), { recursive: true });

    const acceptance = join(dir, "tests", "e2e", "real-component-integration.test.ts");
    writeFileSync(
      acceptance,
      `${readFileSync(acceptance, "utf8")}\nconst regression = new ClaudeCliAdapter({ clock });\n`,
    );

    const result = spawnSync(process.execPath, [join(dir, "scripts", "verify-acceptance-adapter-source.mjs")], {
      encoding: "utf8",
    });
    expect(result.status, "the acceptance replaced the deployment's adapters unnoticed").toBe(1);
    expect(result.stdout).toContain("ClaudeCliAdapter");
  });
});
