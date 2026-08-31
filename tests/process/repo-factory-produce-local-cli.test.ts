import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, it, expect, afterEach } from "vitest";

import { parseRepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import type { RepoFactoryPlanFixture } from "../../src/bootstrap/repo-factory-producer.ts";

/**
 * Issue #246 (CEO review round 2, defect 3) — `produceRepoFactoryResult` had zero callers
 * anywhere in `src/`, the exact shape #416 was closed for. `scripts/repo-factory-produce-local.ts`
 * is the real producing-side entrypoint this test spawns as an actual subprocess: it is
 * package.json's `repo-factory:produce-local` command, not an in-process import.
 */

const execFileAsync = promisify(execFile);
const TSX_ENTRY = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const CLI_ENTRY = join(process.cwd(), "scripts", "repo-factory-produce-local.ts");

const sandboxes: string[] = [];

const makeSandbox = (): string => {
  const sandbox = mkdtempSync(join(tmpdir(), "acp-246-cli-"));
  sandboxes.push(sandbox);
  return sandbox;
};

afterEach(async () => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const basePlan = (): RepoFactoryPlanFixture => ({
  runId: "run_bootstrap_246_cli",
  bootstrapOperationId: "bootstrap_246_cli",
  requestDigest: "sha256:" + "a".repeat(64),
  planDigest: "sha256:" + "b".repeat(64),
  projectManifestDigest: "sha256:" + "c".repeat(64),
  repositoryRole: "primary",
  defaultBranch: "main",
  verificationCommandId: "local-clean-tree",
  verificationKind: "CLEAN_TREE",
  githubOperations: [],
});

const writePlan = (sandbox: string, plan: RepoFactoryPlanFixture): string => {
  const planPath = join(sandbox, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  return planPath;
};

describe("repo-factory:produce-local CLI (#246)", () => {
  it("produces a RepoFactoryResult through the real canonical parser when spawned as a subprocess", async () => {
    const sandbox = makeSandbox();
    const planPath = writePlan(sandbox, basePlan());
    const workDir = join(sandbox, "workdir");

    const { stdout } = await execFileAsync(
      process.execPath,
      [TSX_ENTRY, CLI_ENTRY, `--plan=${planPath}`, `--work-dir=${workDir}`],
      { cwd: process.cwd() },
    );

    const printed = JSON.parse(stdout) as unknown;
    // The CLI's own printed output is what a real caller would consume — parsing it again
    // here through the same canonical parser proves the entrypoint's stdout contract, not
    // just that the in-process function returned something parseable.
    const parsed = parseRepoFactoryResult(printed);
    expect(parsed.allowed).toBe(true);
  });

  it("exits non-zero and never fabricates a receipt when the plan requires a GitHub write", async () => {
    const sandbox = makeSandbox();
    const plan: RepoFactoryPlanFixture = {
      ...basePlan(),
      githubOperations: [
        { operationId: "repo-create", resourceType: "repository", resourceIdentity: "github:acme/repo" },
      ],
    };
    const planPath = writePlan(sandbox, plan);
    const workDir = join(sandbox, "workdir");

    await expect(
      execFileAsync(process.execPath, [TSX_ENTRY, CLI_ENTRY, `--plan=${planPath}`, `--work-dir=${workDir}`], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("prints usage and exits non-zero when required flags are missing", async () => {
    await expect(
      execFileAsync(process.execPath, [TSX_ENTRY, CLI_ENTRY], { cwd: process.cwd() }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("CEO review round 3, defect 1 — the exact attack CEO ran through the real CLI is now refused, not just in-process", async () => {
    const sandbox = makeSandbox();
    const outsideTarget = join(sandbox, "outside-target");
    mkdirSync(outsideTarget, { recursive: true });
    // Reconstructed verbatim: a plan carrying the old `verificationArgs` shape with a second
    // `-C` aimed outside workDir. The field no longer exists in the schema, so this is
    // rejected before any git call — but the point of a process-level test is proving that
    // holds through the real CLI's JSON parsing, not only the in-process object shape.
    const attackPlanPath = join(sandbox, "plan.json");
    writeFileSync(
      attackPlanPath,
      JSON.stringify({ ...basePlan(), verificationArgs: ["-C", outsideTarget, "init", "-b", "pwn"] }),
    );
    const workDir = join(sandbox, "workdir");

    await expect(
      execFileAsync(
        process.execPath,
        [TSX_ENTRY, CLI_ENTRY, `--plan=${attackPlanPath}`, `--work-dir=${workDir}`],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 1 });

    expect(existsSync(join(outsideTarget, ".git"))).toBe(false);
    expect(readdirSync(outsideTarget)).toEqual([]);
  });

  it("CEO review round 5, defect 2 — two real concurrent processes creating the same checkout: exactly one succeeds, decided by the kernel, not a check either process could race between", async () => {
    // Real, separate OS processes — genuine concurrency a single Node event loop cannot
    // reproduce. Reproduced directly against commit 7d6b580 (the previous, recursive-mkdir
    // shape) before this fix: two such processes racing the same path did not deterministically
    // split 1-1 — one run crashed outright (`ENOTEMPTY` during a concurrent `rmSync` cleanup
    // colliding with the other process's still-open writes into the same directory), because
    // recursive `mkdirSync` treats an already-existing directory as success for *both*
    // callers, giving no collision signal at all. Against the fix below, five consecutive real
    // concurrent runs each split exactly 1 success / 1 collision, in either order, with no
    // crash — the invariant this test pins.
    const sandbox = makeSandbox();
    const workDir = join(sandbox, "workdir");
    const planAPath = writePlan(sandbox, basePlan());
    const planBPath = join(sandbox, "plan-b.json");
    writeFileSync(planBPath, JSON.stringify({ ...basePlan(), bootstrapOperationId: "bootstrap_246_cli_concurrent_b" }));

    const spawn = (planPath: string) =>
      execFileAsync(process.execPath, [TSX_ENTRY, CLI_ENTRY, `--plan=${planPath}`, `--work-dir=${workDir}`], {
        cwd: process.cwd(),
      });

    const [a, b] = await Promise.allSettled([spawn(planAPath), spawn(planBPath)]);
    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.status === "fulfilled");
    const failed = outcomes.filter((o) => o.status === "rejected");
    // The invariant is the split, not which process wins — genuine OS scheduling decides
    // that, and the kernel's atomic `mkdir` decides the split regardless of the order.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const loser = failed[0] as PromiseRejectedResult;
    expect((loser.reason as { code?: number }).code).toBe(1);
  });
});
