import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, "scripts", "verify-ci-preflight.mjs");

const run = (repoRoot: string) =>
  spawnSync(process.execPath, [SCRIPT, `--repo-root=${repoRoot}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

const scratchRepo = (): string => {
  const repoRoot = join(tempDir("acp-ci-preflight-"), "repo");
  mkdirSync(join(repoRoot, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repoRoot, "package.json"),
    JSON.stringify(
      {
        scripts: {
          "ci:preflight": "node scripts/verify-ci-preflight.mjs",
          lint: "eslint .",
          trace: "tsx src/tools/traceability.ts",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoRoot, ".github", "workflows", "ci.yml"),
    [
      "name: fixture-ci",
      "on: [push]",
      "jobs:",
      "  verify:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm install --frozen-lockfile",
      "      - run: pnpm lint",
      "      - run: |",
      "          pnpm trace",
      '          echo "the matrix succeeded"',
      "",
    ].join("\n"),
  );
  return repoRoot;
};

describe("ci preflight", () => {
  it("accepts every repository workflow command", () => {
    const result = run(REPO_ROOT);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ci-preflight: [1-9]\d* workflow file/);
    expect(result.stdout).toContain("every package script exists");
    expect(result.stdout).toContain("every run command parses under Bash");

    const hook = readFileSync(join(REPO_ROOT, ".githooks", "pre-commit"), "utf8");
    expect(hook.indexOf("pnpm ci:preflight")).toBeGreaterThan(-1);
    expect(hook.indexOf("pnpm ci:preflight")).toBeLessThan(hook.indexOf("--anchors-only"));

    const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow.indexOf("run: pnpm ci:preflight")).toBeGreaterThan(-1);
    expect(workflow.indexOf("run: pnpm ci:preflight")).toBeLessThan(
      workflow.indexOf("run: pnpm install --frozen-lockfile"),
    );
  });

  it("rejects a workflow pnpm command whose package script is missing", () => {
    const repoRoot = scratchRepo();
    const packagePath = join(repoRoot, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    delete packageJson.scripts.trace;
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    const result = run(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing package script "trace"');
  });

  it("rejects an unmatched quote in a workflow run block", () => {
    const repoRoot = scratchRepo();
    const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
    const workflow = readFileSync(workflowPath, "utf8").replace(
      'echo "the matrix succeeded"',
      'echo "the matrix succeeded""',
    );
    writeFileSync(workflowPath, workflow);

    const result = run(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run command fails bash -n");
    expect(result.stderr).toContain("syntax error");
  });
});
