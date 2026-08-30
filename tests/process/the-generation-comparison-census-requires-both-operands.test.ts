import { afterAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const ROOT = process.cwd();
const SCRIPT = "scripts/verify-generation-bound-comparisons.mjs";

const run = (directory: string): { status: number | null; stdout: string; stderr: string } => {
  const done = spawnSync(process.execPath, [SCRIPT], { cwd: directory, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
};

const scratchRepo = (): string => {
  const directory = join(tempDir("acp-generation-comparison-census-"), "repo");
  mkdirSync(join(directory, "scripts"), { recursive: true });
  cpSync(join(ROOT, SCRIPT), join(directory, SCRIPT));
  cpSync(join(ROOT, "src"), join(directory, "src"), { recursive: true });
  cpSync(join(ROOT, "tsconfig.json"), join(directory, "tsconfig.json"));
  symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir");
  return directory;
};

const rewrite = (directory: string, path: string, edit: (source: string) => string): void => {
  const fullPath = join(directory, path);
  const source = readFileSync(fullPath, "utf8");
  const changed = edit(source);
  if (changed === source) throw new Error(`fixture mutation did not change ${path}`);
  writeFileSync(fullPath, changed);
};

describe("the generation comparison census requires both operands", () => {
  it("passes on the working tree and inspects a nonzero comparison census", () => {
    const done = run(ROOT);

    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toMatch(/\d+ comparison site/);
    expect(done.stdout).toContain("pass both generation operands");
  });

  it("fails when comparison discovery returns an empty list", () => {
    const directory = scratchRepo();
    rewrite(directory, SCRIPT, (source) =>
      source
        .replace(/const EXEMPTIONS = \[[\s\S]*?\n\];/, "const EXEMPTIONS = [];")
        .replace("const sites = discoverComparisonSites();", "const sites = [];"),
    );

    const done = run(directory);

    expect(done.status).toBe(1);
    expect(done.stderr).toContain("found zero comparison sites");
    expect(done.stderr).toContain("unmeasured pass");
  });

  it("fails when one comparison generation argument is removed", () => {
    const directory = scratchRepo();
    rewrite(directory, "src/ceo/production-gate.ts", (source) =>
      source.replace("        current: input.candidateSnapshotDigest,\n", ""),
    );

    const done = run(directory);

    expect(done.status).toBe(1);
    expect(done.stderr).toContain("ProductionGate.buildPacket");
    expect(done.stderr).toContain("no controlling comparison passes both operands");
  });

  it("fails when an exemption no longer names a comparison site", () => {
    const directory = scratchRepo();
    rewrite(directory, SCRIPT, (source) =>
      source.replace(
        "const EXEMPTIONS = [",
        'const EXEMPTIONS = [\n  { target: "src/fixture.ts::missing::STALE::deadbeef", why: "fixture stale exemption" },',
      ),
    );

    const done = run(directory);

    expect(done.status).toBe(1);
    expect(done.stderr).toContain("stale exemption target");
    expect(done.stderr).toContain("fixture stale exemption");
  });
});
