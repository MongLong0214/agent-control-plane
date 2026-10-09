/**
 * `pnpm merge` merges only when the newest `project-ci` run on the exact head has finished and
 * its aggregate `verify` job succeeded.
 *
 * The three stale cases are GitHub states the previous judgement — the bare `verify` checks in the
 * pull request's rollup, newest by `completedAt` — accepted and merged on (#1047 review, R1): a
 * previous run's green `verify` standing alone while the newer run is still in its matrix, an
 * older run that finished later outranking a newer failure, and a pending commit status the
 * rollup reading skipped because it carries no `completedAt`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

const ROOT = process.cwd();
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

type Check = Record<string, string>;
type Run = { databaseId: number; attempt: number; status: string; headSha: string };
type World = { pr: Record<string, unknown>; runs: Run[]; jobs: Record<string, Check[]> };

const pr = (mergeStateStatus: string, statusCheckRollup: Check[]) => ({
  state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus, title: "fixture",
  baseRefOid: BASE, headRefOid: HEAD, statusCheckRollup,
});
const check = (name: string, status: string, conclusion: string, completedAt: string): Check =>
  ({ name, status, conclusion, completedAt, workflowName: "project-ci" });
const job = (name: string, status: string, conclusion: string): Check => ({ name, status, conclusion });
const run = (databaseId: number, attempt: number, status: string, headSha = HEAD): Run =>
  ({ databaseId, attempt, status, headSha });

/** Runs the real merge script with `gh` answering from `world` and `commitlore` doing nothing. */
const merge = (world: World): { status: number | null; stdout: string; merges: string[][] } => {
  const directory = mkdtempSync(join(tmpdir(), "acp-merge-run-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), readFileSync(join(ROOT, "tests/helpers/merge-gh-fixture.mjs")));
  chmodSync(join(bin, "gh"), 0o755);
  // A body with no records gives squash-preserve and validate nothing to say.
  writeFileSync(join(bin, "commitlore"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "commitlore"), 0o755);
  writeFileSync(join(directory, "body"), "body\n");
  writeFileSync(join(directory, "world.json"), JSON.stringify(world));
  const log = join(directory, "gh.log");
  // The fixture switches to other roles on these two, so they must not leak in from the suite.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "FIXTURE_MESSAGE" && key !== "FIXTURE_CLI_RESPONSES"),
  );
  const result = boundedSpawnSync(
    process.execPath,
    [join(ROOT, "scripts/merge-pr.mjs"), "1", "--subject", "fixture", "--body-file", join(directory, "body")],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...inherited,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FIXTURE_HEAD: HEAD,
        FIXTURE_BASE: BASE,
        FIXTURE_GH_WORLD: join(directory, "world.json"),
        FIXTURE_GH_LOG: log,
      },
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
  return {
    status: result.status,
    stdout: result.stdout,
    merges: calls.filter((call) => call[0] === "pr" && call[1] === "merge"),
  };
};

describe("a merge is judged by the newest project-ci run on the head", () => {
  it("refuses a previous run's green verify while the newer run is still in its matrix", () => {
    const result = merge({
      pr: pr("UNSTABLE", [
        check("verify", "COMPLETED", "SUCCESS", "2026-10-02T01:00:00Z"),
        check("verify (22.23.2)", "IN_PROGRESS", "", "0001-01-01T00:00:00Z"),
      ]),
      runs: [run(100, 1, "completed"), run(200, 1, "in_progress")],
      jobs: {
        "100/1": [job("verify (22.23.2)", "completed", "success"), job("verify", "completed", "success")],
        "200/1": [job("verify (22.23.2)", "in_progress", "")],
      },
    });

    expect(result.merges, result.stdout).toEqual([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("project-ci run 200 attempt 1 on bbbbbbb is in_progress");
  });

  it("refuses when an older run that finished later is green and the newer run failed", () => {
    const result = merge({
      pr: pr("UNSTABLE", [
        check("verify", "COMPLETED", "SUCCESS", "2026-10-02T01:40:00Z"),
        check("verify", "COMPLETED", "FAILURE", "2026-10-02T01:20:00Z"),
      ]),
      runs: [run(100, 1, "completed"), run(200, 1, "completed")],
      jobs: {
        "100/1": [job("verify", "completed", "success")],
        "200/1": [job("verify", "completed", "failure")],
      },
    });

    expect(result.merges, result.stdout).toEqual([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("job of project-ci run 200 attempt 1 is completed/failure");
  });

  it("refuses a pending commit status named verify, which carries no completedAt", () => {
    const result = merge({
      pr: pr("UNSTABLE", [
        check("verify", "COMPLETED", "SUCCESS", "2026-10-02T01:00:00Z"),
        { context: "verify", state: "PENDING", startedAt: "2026-10-02T01:30:00Z" },
      ]),
      runs: [run(100, 1, "completed")],
      jobs: { "100/1": [job("verify", "completed", "success")] },
    });

    expect(result.merges, result.stdout).toEqual([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("commit status on bbbbbbb is PENDING");
  });

  it("judges a run by its latest attempt, not by an earlier green one", () => {
    const result = merge({
      pr: pr("CLEAN", [check("verify", "COMPLETED", "SUCCESS", "2026-10-02T01:00:00Z")]),
      runs: [run(100, 2, "completed")],
      jobs: {
        "100/1": [job("verify", "completed", "success")],
        "100/2": [job("verify", "completed", "failure")],
      },
    });

    expect(result.merges, result.stdout).toEqual([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("project-ci run 100 attempt 2 is completed/failure");
  });

  it("refuses a head no project-ci run has looked at", () => {
    const result = merge({
      pr: pr("CLEAN", [check("verify", "COMPLETED", "SUCCESS", "2026-10-02T01:00:00Z")]),
      runs: [run(300, 1, "completed", "c".repeat(40))],
      jobs: { "300/1": [job("verify", "completed", "success")] },
    });

    expect(result.merges, result.stdout).toEqual([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no project-ci run on bbbbbbb");
  });

  it("merges the checked head when the newest run is green, whatever a cancelled older run left", () => {
    // The state that used to need a fresh commit to get past: an older run cancelled mid-way, one
    // of its jobs since deleted from the workflow, both still CANCELLED on the head.
    const result = merge({
      pr: pr("UNSTABLE", [
        check("guard falsifiability (1/4)", "COMPLETED", "CANCELLED", "2026-10-02T01:00:00Z"),
        check("verify", "COMPLETED", "CANCELLED", "2026-10-02T01:00:00Z"),
        check("verify", "COMPLETED", "SUCCESS", "2026-10-02T02:00:00Z"),
      ]),
      runs: [run(100, 1, "completed"), run(200, 1, "completed")],
      jobs: {
        "100/1": [job("verify", "completed", "cancelled")],
        "200/1": [job("verify (22.23.2)", "completed", "success"), job("verify", "completed", "success")],
      },
    });

    expect(result.merges, result.stdout).toHaveLength(1);
    expect(result.merges[0]).toEqual(expect.arrayContaining(["--match-head-commit", HEAD]));
    // This world has no merge commit for the read-back to find, so after merging the script fails
    // loudly rather than claim it; a-merge-names-the-head-it-checked.test.ts reads a real one back.
    expect(result.stdout).toContain("RESULT: FAIL — #1 is merged, and reading it back does not match what was checked");
    expect(result.status).toBe(1);
  });
});
