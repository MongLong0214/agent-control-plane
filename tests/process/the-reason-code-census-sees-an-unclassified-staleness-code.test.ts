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
 * `#704` (open at the time this test was written) fixes the real, pre-existing
 * `CEO_CONVERSATION_STALE` defect this issue's measurement found. This test does not assume
 * that fix has landed: it measures the working tree's own baseline exit code first, then
 * proves that adding one synthetic `_STALE` code with no `STALENESS_REASON_CODES` entry is
 * exactly what turns a run red, and that removing that one addition returns to the measured
 * baseline — so the assertion holds whether #704 has merged yet or not.
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
  it("measures the working tree's own baseline first, so later assertions don't assume #704 has merged", () => {
    const baseline = censusOn(CURRENT());
    // Either possible baseline is a valid starting point for the rest of this file: 0 if #704
    // has merged, 1 (naming CEO_CONVERSATION_STALE) if it has not. Anything else means the
    // fixture stopped matching the file it reads.
    expect([0, 1]).toContain(baseline.status);
  });

  it("fails on a synthetic _STALE code with no STALENESS_REASON_CODES entry", () => {
    const done = censusOn(withUnclassifiedStalenessCode(CURRENT()));

    expect(done.status).toBe(1);
    expect(done.stderr).toContain("CENSUS_PROBE_SYNTHETIC_STALE");
    expect(done.stderr).toContain("absent from STALENESS_REASON_CODES");
  });

  it("returns to the measured baseline once the synthetic code is removed", () => {
    const baseline = censusOn(CURRENT());
    const injected = censusOn(withUnclassifiedStalenessCode(CURRENT()));
    const restored = censusOn(CURRENT());

    expect(injected.status).toBe(1);
    expect(restored.status).toBe(baseline.status);
    expect(restored.stderr).not.toContain("CENSUS_PROBE_SYNTHETIC_STALE");
  });
});
