import { describe, expect, it, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #705 — `scripts/verify-reason-codes.mjs` is a correct, dependency-free check that was in
 * neither `package.json` nor `ci.yml`: it has been reporting a real defect
 * (`CEO_CONVERSATION_STALE` unclassified in `STALENESS_REASON_CODES`) into an empty room for
 * as long as that defect existed. Wiring it into `pnpm reason-codes` and `ci.yml`'s
 * verify-matrix closes half of #705; this file is the other half — proof that the census
 * actually *sees* the shape it exists to catch, in the style of
 * tests/process/the-replace-census-sees-every-guard-form.test.ts and
 * tests/process/the-tx-denial-census-sees-a-write-then-deny.test.ts.
 *
 * `#704` fixed the real `CEO_CONVERSATION_STALE` defect this issue's measurement found. The
 * production entrypoint must therefore be green before this check is wired into CI. This test
 * runs that entrypoint in the actual worktree and requires exit 0, then proves in a scratch
 * copy that adding one synthetic `_STALE` code with no `STALENESS_REASON_CODES` entry turns
 * the same census red and removing the addition turns it green again.
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-reason-codes.mjs";
const CATALOGUE = "src/core/reason-codes.ts";

/** A copy of the census script and the one file it reads — not a git clone, so this measures
 * the catalogue as it stands right now, uncommitted changes included. */
const scratchRepo = (catalogueSource: string): string => {
  const dir = join(tempDir("acp-reason-code-census-"), "repo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "src", "core"), { recursive: true });
  writeFileSync(join(dir, SCRIPT), readFileSync(join(ROOT, SCRIPT)));
  writeFileSync(join(dir, CATALOGUE), catalogueSource);
  return dir;
};

const censusOn = (catalogueSource: string): { status: number | null; stdout: string; stderr: string } => {
  const repo = scratchRepo(catalogueSource);
  const done = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
};

const runRealEntrypoint = (): { status: number | null; stdout: string; stderr: string } => {
  const done = spawnSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
};

const CURRENT = () => readFileSync(join(ROOT, CATALOGUE), "utf8");

/** Inserts one new code, ending in `_STALE`, immediately before the catalogue's closing brace —
 * declared but never added to STALENESS_REASON_CODES, which is exactly the shape #448/#705's
 * own measurement found real (`CEO_CONVERSATION_STALE`). */
const withUnclassifiedStalenessCode = (source: string): string => {
  const marker = "\n} as const;";
  const at = source.indexOf(marker);
  if (at === -1) throw new Error("fixture assumption broke: catalogue's closing `} as const;` not found");
  return `${source.slice(0, at)}\n  CENSUS_PROBE_SYNTHETIC_STALE: "CENSUS_PROBE_SYNTHETIC_STALE",${source.slice(at)}`;
};

describe("the reason-code census reports a staleness verdict absent from STALENESS_REASON_CODES", () => {
  it("the real entrypoint exits 0 on the working tree", () => {
    const done = runRealEntrypoint();

    expect(done.status).toBe(0);
    expect(done.stdout).toContain("none missing");
  });

  it("fails on a synthetic _STALE code with no STALENESS_REASON_CODES entry", () => {
    const done = censusOn(withUnclassifiedStalenessCode(CURRENT()));

    expect(done.status).toBe(1);
    expect(done.stderr).toContain("CENSUS_PROBE_SYNTHETIC_STALE");
    expect(done.stderr).toContain("absent from STALENESS_REASON_CODES");
  });

  it("exits 0 again once the synthetic code is removed", () => {
    const injected = censusOn(withUnclassifiedStalenessCode(CURRENT()));
    const restored = censusOn(CURRENT());

    expect(injected.status).toBe(1);
    expect(restored.status).toBe(0);
    expect(restored.stderr).not.toContain("CENSUS_PROBE_SYNTHETIC_STALE");
  });
});
