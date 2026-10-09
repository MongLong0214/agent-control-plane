/**
 * `pnpm merge` writes the head it checked into the squash as `Merged-Head: <sha>`, hands GitHub the
 * same sha as `--match-head-commit`, and reads the merge back -- the trailer, the tree and the
 * records -- failing loudly on any mismatch, because the merge itself cannot be undone.
 *
 * `scripts/verify-merge-preserved-records.mjs` reads a squash's branch up to that trailer and
 * nothing else (narrow review 5 showed the pull request's `head.sha` and every corroboration of it
 * accept a rewritten or rolled-back head), so a merge without it is unverifiable on `main`.
 *
 * These run the real script against a real repository whose `origin` is a local bare repository.
 * The `gh` stand-in composes the squash there the way GitHub does -- subject, blank line, body;
 * the head merged onto the base -- and can be told to compose it wrongly. The `commitlore`
 * stand-in leaves the draft as it is and mirrors the branch's records onto the merge as a note,
 * which is what `squash-preserve --target` does. `GIT_DIR` points every git call, the script's and
 * the gate's, at the fixture.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fakeGitHub } from "../helpers/fake-github-pulls.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const ROOT = process.cwd();
const LIMIT = "Limit: the first half's record, which a squash strands mid-message";
const WARN = "Warn: the second half's record, in the last paragraph";

const IDENTITY = {
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", timeout: 30_000, env: { ...process.env, ...IDENTITY, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();

/** As `gh`: the pull request, its one green run, the merge composed in the bare origin, and the REST read-back. */
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
    baseRefOid: world.base, headRefOid: world.headRefOid ?? world.head, statusCheckRollup: [] }));
} else if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ databaseId: 1, attempt: 1, status: "completed", headSha: world.head }].filter((r) => r.headSha === flag("--commit"))));
} else if (args[0] === "run" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ jobs: [{ name: "verify", status: "completed", conclusion: "success" }] }));
} else if (args[0] === "pr" && args[1] === "merge") {
  if (flag("--match-head-commit") !== world.head) { process.stderr.write("Head branch was modified\n"); process.exit(1); }
  const body = fs.readFileSync(flag("--body-file"), "utf8");
  fs.writeFileSync(world.sentBody, body);
  let message = flag("--subject") + "\n\n" + body;
  const named = "Merged-Head: " + world.head;
  if (world.tamper === "drop-trailer") message = message.replace(named + "\n\n", "");
  if (world.tamper === "other-head") message = message.replace(named, "Merged-Head: " + world.first);
  if (world.tamper === "duplicate-trailer") message = message + "\n" + named + "\n";
  fs.writeFileSync(world.composed, message);
  const tree = origin("merge-tree", "--write-tree", "refs/heads/main", world.tamper === "tree" ? world.first : world.head).split("\n")[0];
  const parents = world.tamper === "merge-commit" ? ["-p", "refs/heads/main", "-p", world.head] : ["-p", "refs/heads/main"];
  const squash = origin("commit-tree", tree, ...parents, "-F", world.composed);
  origin("update-ref", "refs/heads/main", squash);
  fs.writeFileSync(world.state, JSON.stringify({ merged: squash }));
} else if (args[0] === "api" && args.includes("--include") && /\/pulls\/\d+$/.test(args[args.length - 1])) {
  const merged = state.merged !== undefined && world.apiMerged !== false;
  process.stdout.write("HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n" +
    JSON.stringify({ number: world.number, merged, merge_commit_sha: merged ? state.merged : null }));
} else process.exit(2);
`;

/** As `commitlore`: the draft is left alone; `--target` mirrors every branch record onto the merge as a note. */
const COMMITLORE = String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const world = JSON.parse(fs.readFileSync(process.env.MERGE_WORLD, "utf8"));
const args = process.argv.slice(2);
const git = (a, input) => execFileSync("git", a, { encoding: "utf8", input, timeout: 30000 });
if (args[0] === "squash-preserve" && args.includes("--target")) {
  if (world.noNotes) { process.stdout.write("could not write the note\n"); process.exit(1); }
  const lines = [];
  for (const sha of git(["rev-list", "--reverse", args[1]]).split("\n").filter(Boolean)) {
    const parsed = git(["interpret-trailers", "--parse"], git(["log", "-1", "--format=%B", sha]));
    lines.push(...parsed.split("\n").filter((line) => /^(Limit|Warn):/.test(line)));
  }
  git(["notes", "--ref=commitlore", "add", "-f", "-m", lines.join("\n"), args[args.indexOf("--target") + 1]]);
  process.stdout.write(lines.length + " record(s) mirrored\n");
} else if (!["squash-preserve", "validate", "sync"].includes(args[0])) process.exit(2);
`;

interface Options {
  readonly tamper?: "drop-trailer" | "other-head" | "duplicate-trailer" | "tree" | "merge-commit";
  readonly noNotes?: boolean;
  readonly apiMerged?: boolean;
  readonly headRefOid?: string;
  readonly body?: string;
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
  git(work, "push", "--quiet", "--no-verify", "origin", "main", "feature");

  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${GH}`);
  writeFileSync(join(bin, "commitlore"), `#!${process.execPath}\n${COMMITLORE}`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "commitlore"), 0o755);
  writeFileSync(join(dir, "body"), options.body ?? "Summary.\n");
  const files = { log: join(dir, "gh.log"), state: join(dir, "state.json"), composed: join(dir, "composed"), sentBody: join(dir, "sent-body") };
  writeFileSync(join(dir, "world.json"), JSON.stringify({
    origin, base, first, head, number: 8, ...files,
    tamper: options.tamper, noNotes: options.noNotes ?? false, apiMerged: options.apiMerged, headRefOid: options.headRefOid,
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
    stdout = execFileSync(process.execPath, [join(ROOT, "scripts/merge-pr.mjs"), "8", "--subject", "feat: both halves (#8)",
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

describe("a merge names the head it checked, and is read back", () => {
  it("writes Merged-Head as the head CI was checked on, passes the same sha to --match-head-commit, and reads it back", () => {
    const w = mergeWorld();
    const result = merge(w);
    expect(result.status, result.stdout).toBe(0);
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]).toEqual(expect.arrayContaining(["--match-head-commit", w.head]));
    expect(readFileSync(w.files.sentBody, "utf8").startsWith(`Merged-Head: ${w.head}\n\nSummary.`)).toBe(true);
    const merged = result.merged ?? "";
    const message = git(w.work, "--git-dir", w.origin, "log", "-1", "--format=%B", merged);
    expect(message.split("\n").filter((line) => /merged-head/iu.test(line))).toEqual([`Merged-Head: ${w.head}`]);
    expect(result.stdout).toContain(`read back ${merged.slice(0, 7)}: Merged-Head ${w.head.slice(0, 7)}`);
    expect(result.stdout).toContain("2 record line(s) all reachable");
    expect(result.stdout).toContain(`RESULT: PASS — #8 merged at ${w.head.slice(0, 7)}.`);

    // And the gate CI runs on `main` agrees, from GitHub's answer and the trailer alone.
    const env = fakeGitHub(w.dir, { 8: { merged: true, mergeCommit: merged, head: w.first } });
    const gate = execFileSync(process.execPath, [join(ROOT, "scripts/verify-merge-preserved-records.mjs"), `${w.base}..${merged}`],
      { cwd: w.work, env, encoding: "utf8", timeout: 60_000 });
    expect(gate).toContain(`#8  2 record line(s) on the branch, all reachable from ${merged.slice(0, 8)} (the branch read up to its merge-time head ${w.head.slice(0, 8)})`);
    expect(gate).toContain("RESULT: PASS");
  });

  it("fails loudly when the merge commit does not carry the trailer", () => {
    expectLoud(merge(mergeWorld({ tamper: "drop-trailer" })), "carries no Merged-Head trailer");
  });

  it("fails loudly when the trailer names another head", () => {
    const w = mergeWorld({ tamper: "other-head" });
    expectLoud(merge(w), `its Merged-Head is ${w.first.slice(0, 8)}, not the head checked, ${w.head.slice(0, 8)}`);
  });

  it("fails loudly when the merge commit carries the trailer twice", () => {
    expectLoud(merge(mergeWorld({ tamper: "duplicate-trailer" })), "carries 2 duplicate Merged-Head trailers");
  });

  it("fails loudly when the merge commit's tree is not the checked head merged onto its parent", () => {
    const w = mergeWorld({ tamper: "tree" });
    expectLoud(merge(w), `is not ${w.head.slice(0, 8)} merged onto its parent ${w.base.slice(0, 8)}`);
  });

  it("fails loudly when GitHub made a merge commit rather than a squash", () => {
    const w = mergeWorld({ tamper: "merge-commit" });
    const result = merge(w);
    expectLoud(result, `${(result.merged ?? "").slice(0, 8)} has 2 parent(s), not the one a squash has`);
  });

  it("fails loudly when a branch record is reachable from the merge neither as a trailer nor in its note", () => {
    const w = mergeWorld({ noNotes: true });
    const result = merge(w);
    expect(result.stdout).toContain("WARN  the note for");
    expectLoud(result, `it does not keep ${w.first.slice(0, 8)}'s record line "${LIMIT}"`);
  });

  it("fails loudly when GitHub does not report the pull request merged", () => {
    expectLoud(merge(mergeWorld({ apiMerged: false })), "GitHub does not report #8 as merged");
  });
});

describe("a merge whose message cannot name the checked head is refused before it exists", () => {
  it("when the body already carries a Merged-Head line", () => {
    const w = mergeWorld({ body: `Summary.\n\nMerged-Head: ${"c".repeat(40)}\n` });
    const result = merge(w);
    expect(result.merges, result.stdout).toEqual([]);
    expect(result.stdout).toContain("the merge message carries 2 conflicting Merged-Head trailers");
    expect(result.stdout).toContain("Refusing before it becomes history.");
    expect(result.status).toBe(1);
  });

  it("when GitHub's head is not one full sha", () => {
    const w = mergeWorld({ headRefOid: "main" });
    const result = merge(w);
    expect(result.merges, result.stdout).toEqual([]);
    expect(result.stdout).toContain("#8's head from GitHub is not one full commit sha (main).");
    expect(result.status).toBe(1);
  });

  it("and a dry run merges nothing", () => {
    const w = mergeWorld();
    const result = merge(w, ["--dry-run"]);
    expect(result.merges, result.stdout).toEqual([]);
    expect(result.stdout).toContain("RESULT: PASS — checks only, nothing merged (--dry-run).");
    expect(result.status).toBe(0);
  });
});
