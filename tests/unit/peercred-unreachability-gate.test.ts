import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { acpScratchDir } from "../../src/core/scratch-root.ts";

/**
 * `scripts/verify-peercred-is-unreachable.mjs` enforces #539's central acceptance: nothing in
 * `src/` may reach `getPeerCredentials`/`PeerCredentials` outside `src/core/peercred.ts` itself.
 * A gate that enforces this only against the shape of code that happens to exist today is not
 * proven — the script's own docstring names what it does not resolve (a runtime-assembled
 * specifier), and an earlier version of it additionally missed something it did not name: a
 * same-directory namespace re-export. This file drives the script against synthetic trees rather
 * than trusting its own account, in the shape `acceptance-adapter-source.test.ts` already uses
 * for a sibling census script.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "verify-peercred-is-unreachable.mjs");
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Copies just what the script reads (`src/`) into a fresh scratch root, so each case mutates its
 * own tree. The script's own `ROOT` is computed as "one directory above wherever this file is",
 * so it is copied to `scripts/` under the scratch root — the same relative position it has in
 * this repository — rather than the scratch root's top level.
 */
const scratchTree = (): string => {
  const dir = mkdtempSync(join(acpScratchDir("acp-peercred-gate-"), "tree"));
  scratch.push(dir);
  cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });
  return dir;
};

const runGate = (dir: string) => spawnSync(process.execPath, [join(dir, "scripts", "verify-peercred-is-unreachable.mjs")], {
  cwd: dir,
  encoding: "utf8",
});

describe("the peercred primitive stays unreachable from every live surface (#539)", () => {
  it("passes against the tree as committed", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails on a direct import from a live surface", () => {
    const dir = scratchTree();
    const target = join(dir, "src", "daemon", "agentcpd.ts");
    writeFileSync(target, 'import { getPeerCredentials } from "../core/peercred.ts";\nvoid getPeerCredentials;\n');
    const result = runGate(dir);
    expect(result.status, "a direct import of the primitive went unnoticed").toBe(1);
    expect(result.stdout).toContain("agentcpd.ts");
  });

  it("fails on a same-directory namespace re-export under a different name", () => {
    // The gap an earlier version of this script's own docstring did not name: `export * as X`
    // from inside src/core/ names neither `core/peercred` (the path is bare `./peercred.ts`
    // there) nor the identifiers themselves (a namespace export renames everything). Verified
    // empirically before the fix: this exact file made the previous version print PASS.
    const dir = scratchTree();
    writeFileSync(join(dir, "src", "core", "reexport-probe.ts"), 'export * as PC from "./peercred.ts";\n');
    const result = runGate(dir);
    expect(result.status, "a same-directory namespace re-export went unnoticed").toBe(1);
    expect(result.stdout).toContain("reexport-probe.ts");
  });

  it("fails on a re-export written through the @/ alias", () => {
    const dir = scratchTree();
    writeFileSync(
      join(dir, "src", "core", "alias-probe.ts"),
      'export { getPeerCredentials } from "@/core/peercred.ts";\n',
    );
    const result = runGate(dir);
    expect(result.status, "an @/-aliased re-export went unnoticed").toBe(1);
    expect(result.stdout).toContain("alias-probe.ts");
  });
});
