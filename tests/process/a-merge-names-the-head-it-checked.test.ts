/**
 * `pnpm merge` merges a pull request as a merge commit and nothing else (#1269), hands GitHub the head
 * whose CI it checked as `--match-head-commit`, and reads the merge back -- its two parents, its tree
 * and the branch's CommitLore notes on origin -- failing loudly on any mismatch, because the merge
 * itself cannot be undone.
 *
 * These run the real script against a real repository whose `origin` is a local bare repository.
 * The `gh` stand-in is a repository that allows merge commits only: it refuses any other method,
 * and composes the merge in the bare origin the way GitHub does -- the base and the head as
 * parents, their merged tree, subject and body as the message -- and can be told to compose it
 * wrongly. The `commitlore` stand-in validates nothing and pushes the notes ref on `sync`. `GIT_DIR`
 * points every git call at the fixture.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const ROOT = process.cwd();
const LIMIT = "Limit: the first half's record";
const WARN = "Warn: the second half's record";

const IDENTITY = {
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", timeout: 30_000, env: { ...process.env, ...IDENTITY, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();

/** As `gh`: the pull request, its one green run, a merge-commit-only merge composed in the bare origin, and the REST read-back. */
const GH = String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const world = JSON.parse(fs.readFileSync(process.env.MERGE_WORLD, "utf8"));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
fs.appendFileSync(world.log, JSON.stringify(args) + "\n");
const env = { ...process.env };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
const origin = (...a) => execFileSync("git", ["--git-dir", world.origin, ...a], { encoding: "utf8", env, timeout: 30000 }).trim();
const state = fs.existsSync(world.state) ? JSON.parse(fs.readFileSync(world.state, "utf8")) : {};
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "fixture",
    baseRefOid: world.baseRefOid ?? world.base, headRefOid: world.headRefOid ?? world.head, statusCheckRollup: [] }));
} else if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ databaseId: 1, attempt: 1, status: "completed", headSha: world.head }].filter((r) => r.headSha === flag("--commit"))));
} else if (args[0] === "run" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ jobs: [{ name: "verify", status: "completed", conclusion: "success" }] }));
} else if (args[0] === "pr" && args[1] === "merge") {
  if (!args.includes("--merge") || args.includes("--squash") || args.includes("--rebase")) {
    process.stderr.write("Merge method not allowed on this repository: merge commits only\n"); process.exit(1);
  }
  if (flag("--match-head-commit") !== world.head) { process.stderr.write("Head branch was modified\n"); process.exit(1); }
  fs.writeFileSync(world.composed, flag("--subject") + "\n\n" + fs.readFileSync(flag("--body-file"), "utf8"));
  const firstParent = world.tamper === "base" ? world.first : "refs/heads/main";
  const tree = origin("merge-tree", "--write-tree", firstParent, world.tamper === "tree" ? world.first : world.head).split("\n")[0];
  const parents = world.tamper === "squash" ? ["-p", firstParent] : ["-p", firstParent, "-p", world.head];
  const merged = origin("commit-tree", tree, ...parents, "-F", world.composed);
  origin("update-ref", "refs/heads/main", merged);
  fs.writeFileSync(world.state, JSON.stringify({ merged }));
} else if (args[0] === "api" && args.includes("--include") && /\/pulls\/\d+$/.test(args[args.length - 1])) {
  const merged = state.merged !== undefined && world.apiMerged !== false;
  process.stdout.write("HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n" +
    JSON.stringify({ number: world.number, merged, merge_commit_sha: merged ? state.merged : null }));
} else process.exit(2);
`;

/** As `commitlore`: `validate` accepts; `sync` pushes the notes ref unless the world says it cannot. */
const COMMITLORE = String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const world = JSON.parse(fs.readFileSync(process.env.MERGE_WORLD, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "sync") {
  if (world.noSync) { process.stdout.write("the records for these commits are still only local\n"); process.exit(1); }
  execFileSync("git", ["push", "--quiet", "origin", "refs/notes/commitlore"], { timeout: 30000 });
} else if (args[0] !== "validate") process.exit(2);
`;

interface Options {
  readonly tamper?: "squash" | "base" | "tree";
  readonly noSync?: boolean;
  readonly apiMerged?: boolean;
  readonly headRefOid?: string;
  readonly baseRefOid?: string;
}

const mergeWorld = (options: Options = {}) => {
  const dir = tempDir("acp-merge-head-");
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  git(dir, "init", "--quiet", "-b", "main", work);
  git(work, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(work, "a.txt"), "base\n");
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "--no-verify", "-m", "base");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "remote", "add", "origin", origin);
  git(work, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(work, "a.txt"), "first\n");
  git(work, "commit", "--quiet", "--no-verify", "-am", `feat: the first half\n\n${LIMIT}`);
  const first = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "b.txt"), "second\n");
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "--no-verify", "-m", `feat: the second half\n\n${WARN}`);
  const head = git(work, "rev-parse", "HEAD");
  git(work, "notes", "--ref=commitlore", "add", "-m", LIMIT, first);
  git(work, "push", "--quiet", "--no-verify", "origin", "main", "feature");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${GH}`);
  writeFileSync(join(bin, "commitlore"), `#!${process.execPath}\n${COMMITLORE}`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "commitlore"), 0o755);
  writeFileSync(join(dir, "body"), "Summary.\n");
  const files = { log: join(dir, "gh.log"), state: join(dir, "state.json"), composed: join(dir, "composed") };
  writeFileSync(join(dir, "world.json"), JSON.stringify({
    origin, base, first, head, number: 8, ...files,
    tamper: options.tamper, noSync: options.noSync ?? false, apiMerged: options.apiMerged,
    headRefOid: options.headRefOid, baseRefOid: options.baseRefOid,
  }));
  return { dir, origin, work, base, first, head, files };
};

type MergeWorld = ReturnType<typeof mergeWorld>;

const merge = (w: MergeWorld, extra: readonly string[] = []) => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("FIXTURE_") && key !== "ACP_MERGE_RECORDS_GH" && key !== "GITHUB_REPOSITORY"));
  let status = 0;
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [join(ROOT, "scripts/merge-pr.mjs"), "8", "--subject", "Merge pull request #8",
      "--body-file", join(w.dir, "body"), ...extra], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000,
      env: { ...inherited, ...IDENTITY, PATH: `${join(w.dir, "bin")}:${process.env["PATH"] ?? ""}`, MERGE_WORLD: join(w.dir, "world.json"),
        GIT_DIR: join(w.work, ".git"), GIT_WORK_TREE: w.work, GITHUB_REPOSITORY: "test/repo" },
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    status = failure.status ?? -1;
    stdout = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
  const calls = existsSync(w.files.log)
    ? readFileSync(w.files.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
  const merged = existsSync(w.files.state) ? (JSON.parse(readFileSync(w.files.state, "utf8")) as { merged: string }).merged : undefined;
  return { status, stdout, merges: calls.filter((call) => call[0] === "pr" && call[1] === "merge"), merged };
};

const expectLoud = (result: ReturnType<typeof merge>, fragment: string): void => {
  expect(result.merges, result.stdout).toHaveLength(1);
  expect(result.stdout).toContain("RESULT: FAIL — #8 is merged, and reading it back does not match what was checked");
  expect(result.stdout).toContain(fragment);
  expect(result.stdout).not.toContain("RESULT: PASS — #8 merged");
  expect(result.status, result.stdout).toBe(1);
};

describe("a pull request merges as a merge commit, and is read back as one", () => {
  it("asks GitHub for a merge commit of the checked head, and reads back its parents, tree, records and notes", () => {
    const w = mergeWorld();
    const result = merge(w);
    expect(result.status, result.stdout).toBe(0);
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]).toEqual(expect.arrayContaining(["--merge", "--match-head-commit", w.head]));
    expect(result.merges[0]).not.toContain("--squash");
    const merged = result.merged ?? "";
    expect(git(w.work, "--git-dir", w.origin, "rev-list", "--parents", "-n", "1", merged).split(" ").slice(1)).toEqual([w.base, w.head]);
    expect(readFileSync(w.files.composed, "utf8")).toBe("Merge pull request #8\n\nSummary.\n");
    expect(git(w.work, "--git-dir", w.origin, "notes", "--ref=commitlore", "show", w.first)).toBe(LIMIT);
    expect(result.stdout).toContain(`read back ${merged.slice(0, 7)}: parents ${w.base.slice(0, 7)} and ${w.head.slice(0, 7)}`);
    expect(result.stdout).toContain("2 record line(s) kept on 2 branch commit(s), 1 note(s) on origin");
    expect(result.stdout).toContain(`RESULT: PASS — #8 merged at ${w.head.slice(0, 7)}.`);
  });

  it("fails loudly when GitHub made a single-parent commit rather than a merge commit", () => {
    const w = mergeWorld({ tamper: "squash" });
    const result = merge(w);
    expectLoud(result, `${(result.merged ?? "").slice(0, 8)}'s parents are [${w.base.slice(0, 8)}], not the base and head checked`);
    expect(result.stdout).toContain(`the head checked, ${w.head.slice(0, 8)}, is not an ancestor`);
  });

  it("fails loudly when the merge landed on a base other than the one read before it", () => {
    const w = mergeWorld({ tamper: "base" });
    expectLoud(merge(w), `not the base and head checked, [${w.base.slice(0, 8)}, ${w.head.slice(0, 8)}]`);
  });

  it("fails loudly when the merge commit's tree is not the checked head merged onto the base", () => {
    const w = mergeWorld({ tamper: "tree" });
    expectLoud(merge(w), `is not ${w.head.slice(0, 8)} merged onto ${w.base.slice(0, 8)}`);
  });

  it("fails loudly when a branch commit's note did not reach origin", () => {
    const w = mergeWorld({ noSync: true });
    const result = merge(w);
    expect(result.stdout).toContain("WARN  `commitlore sync` failed");
    expectLoud(result, `origin does not carry ${w.first.slice(0, 8)}'s CommitLore note`);
  });

  it("fails loudly when GitHub does not report the pull request merged", () => {
    expectLoud(merge(mergeWorld({ apiMerged: false })), "GitHub does not report #8 as merged");
  });
});

describe("a merge that cannot be read back is refused before it exists", () => {
  it("when GitHub's head is not one full sha", () => {
    const result = merge(mergeWorld({ headRefOid: "main" }));
    expect(result.merges, result.stdout).toEqual([]);
    expect(result.stdout).toContain("#8's head from GitHub is not one full commit sha (main).");
    expect(result.status).toBe(1);
  });

  it("when GitHub's base is not one full sha", () => {
    const result = merge(mergeWorld({ baseRefOid: "main" }));
    expect(result.merges, result.stdout).toEqual([]);
    expect(result.stdout).toContain("#8's base from GitHub is not one full commit sha (main).");
    expect(result.status).toBe(1);
  });

  it("and a dry run merges nothing", () => {
    const result = merge(mergeWorld(), ["--dry-run"]);
    expect(result.merges, result.stdout).toEqual([]);
    expect(result.stdout).toContain("RESULT: PASS — checks only, nothing merged (--dry-run).");
    expect(result.status).toBe(0);
  });
});
