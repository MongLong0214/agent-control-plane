import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { acpScratchDir } from "../../src/core/scratch-root.ts";

/**
 * Four adapter options were found missing from the acceptance one at a time, three of them by a
 * live run failing hundreds of seconds in. They were not related bugs — they were one structural
 * fact producing a new instance whenever production gained a field: supplying `adapters:` replaces
 * what `ControlPlane` builds instead of merging with it, and nothing says which options were lost.
 *
 * This makes the fifth one fail here instead. Keys only: a test is expected to point at different
 * paths and binaries, and comparing values would fail on every legitimate difference and be
 * switched off. What must not differ is *which* options are set.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "verify-adapter-option-parity.mjs");
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("the acceptance sets every adapter option the deployment sets (#552)", () => {
  it("passes against the tree as committed", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails when production gains an option the acceptance does not set", () => {
    // The mutation is the actual future: someone adds a field to the shipped adapter and the
    // acceptance keeps running without it, silently.
    const dir = mkdtempSync(join(acpScratchDir("acp-adapter-parity-"), "tree"));
    scratch.push(dir);
    cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(repoRoot, "tests"), join(dir, "tests"), { recursive: true });
    cpSync(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });

    const production = join(dir, "src", "app", "control-plane.ts");
    writeFileSync(
      production,
      readFileSync(production, "utf8").replace(
        "new ClaudeCliAdapter({\n        clock: this.clock,",
        "new ClaudeCliAdapter({\n        clock: this.clock,\n        freshnessWindowMs: 1,",
      ),
    );

    const result = spawnSync(process.execPath, [join(dir, "scripts", "verify-adapter-option-parity.mjs")], {
      encoding: "utf8",
    });
    expect(result.status, "a newly shipped adapter option went unnoticed by the acceptance").toBe(1);
    expect(result.stdout).toContain("freshnessWindowMs");
  });
});
