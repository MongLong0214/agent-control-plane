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

describe("the parity parser sees what it claims to see (#552)", () => {
  // The first version of this check had three holes, and all three were invisible because both
  // sides lost the same keys — the comparison agreed while seeing less than it reported. These are
  // the exact inputs that exposed them, kept so a rewrite cannot quietly reintroduce any of them.
  const keysFor = async (literal: string): Promise<Set<string> | null> => {
    // The script is plain JS with no declarations; it is dependency-free by design (PRD §17.4),
    // so it is imported for its behaviour rather than its types.
    const module_ = (await import(
      /* @vite-ignore */ "../../scripts/verify-adapter-option-parity.mjs" as string
    )) as { optionKeys: (source: string, file: string, adapter: string) => Set<string> | null };
    return module_.optionKeys(`new ClaudeCliAdapter(${literal});`, "fixture.ts", "ClaudeCliAdapter");
  };

  it("sees the first property", async () => {
    // Was dropped by every object: the opening brace was consumed matching the nesting token, so
    // the following key had no separator left to match.
    expect([...(await keysFor("{ clock: c, capacityFile: f, denyReadPaths: [] }"))!].sort())
      .toEqual(["capacityFile", "clock", "denyReadPaths"]);
  });

  it("sees shorthand properties", async () => {
    // `{ clock, capacityFile }` has no colons at all.
    expect([...(await keysFor("{ clock, capacityFile, reviewerEgress: { proxy: p } }"))!].sort())
      .toEqual(["capacityFile", "clock", "reviewerEgress"]);
  });

  it("does not count keys nested inside another literal", async () => {
    const keys = (await keysFor("{ clock: c, reviewerEgress: { profilePath: p, proxyPath: q } }"))!;
    expect([...keys].sort()).toEqual(["clock", "reviewerEgress"]);
    expect(keys.has("profilePath"), "a nested key was counted as an option of the adapter").toBe(false);
  });
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
