import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeGitHub } from "../helpers/fake-github-pulls.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `scripts/verify-merge-preserved-records.mjs` asks one question: is every record line the branch
 * carried reachable from the merge commit. Two ways to answer it wrongly, both measured on
 * 2026-09-15 before the script was written:
 *
 *   * ignore the notes mirror, and every correctly-preserved merge reads as a loss -- the
 *     sanctioned path (`commitlore squash-preserve`) puts the lines git will not store *there*,
 *     not in the message, which `merge-pr.mjs` records at 63ace4b6;
 *   * count `Record-Id` alone, and the three losses that script's own header measured -- 19, 30
 *     and 83 record lines -- read as "0 record(s) on the branch", because their branches predate
 *     that key being emitted at all.
 *
 * These build a real repository rather than a fixture of the script's output: the property under
 * test is what git stores and what git hands back, and a double would agree with whatever this
 * test expected.
 */
const ROOT = process.cwd();
const CHECK = join(ROOT, "scripts", "verify-merge-preserved-records.mjs");

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });

/** A branch commit, a squash that keeps only the last paragraph, and the notes mirror beside it. */
const repositoryWithASquashedBranch = (options: {
  readonly branchTrailers: string;
  readonly mergeTrailers: string;
  readonly note?: string;
}): { readonly root: string; readonly dir: string; readonly range: string; readonly head: string; readonly merge: string } => {
  const dir = tempDir("acp-merge-records-");
  mkdirSync(join(dir, "work"), { recursive: true });
  const work = join(dir, "work");
  git(work, "init", "--quiet", "-b", "main");
  git(work, "config", "user.email", "test@example.invalid");
  git(work, "config", "user.name", "test");
  writeFileSync(join(work, "a.txt"), "base\n");
  git(work, "add", "a.txt");
  git(work, "commit", "--quiet", "--no-verify", "-m", "base");
  const base = git(work, "rev-parse", "HEAD").trim();

  // The branch, carrying its record in its own last paragraph.
  git(work, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(work, "a.txt"), "feature\n");
  git(work, "add", "a.txt");
  git(work, "commit", "--quiet", "--no-verify", "-m", `feat: the branch commit\n\n${options.branchTrailers}`);
  const head = git(work, "rev-parse", "HEAD").trim();

  // The squash: one parent, a `(#N)` subject, the head it was merged from as `scripts/merge-pr.mjs`
  // names it, and only what the merge chose to keep.
  git(work, "checkout", "--quiet", "main");
  git(work, "merge", "--quiet", "--squash", "feature");
  git(work, "commit", "--quiet", "--no-verify", "-m", `feat: the branch commit (#7)\n\nMerged-Head: ${head}\n\n${options.mergeTrailers}`);
  const merge = git(work, "rev-parse", "HEAD").trim();
  if (options.note !== undefined) {
    writeFileSync(join(dir, "note.txt"), `${options.note}\n`);
    git(work, "notes", "--ref=commitlore", "add", "-F", join(dir, "note.txt"), merge);
  }

  // `origin` is this repository itself so any fetch the check runs resolves offline.
  git(work, "remote", "add", "origin", work);
  return { root: dir, dir: work, range: `${base}..${merge}`, head, merge };
};

/** The gate asks GitHub what #7 is; offline, the stand-in answers that it merged as this squash. */
const run = (repo: ReturnType<typeof repositoryWithASquashedBranch>): { status: number; out: string } => {
  const env = fakeGitHub(repo.root, { 7: { merged: true, mergeCommit: repo.merge } });
  try {
    const out = execFileSync(process.execPath, [CHECK, repo.range], { cwd: repo.dir, env, encoding: "utf8", timeout: 60_000 });
    return { status: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
};

const LIMIT = "Limit: the branch said something the diff cannot show";
const WARN = "Warn: and something for whoever touches it next";

describe("a merge that drops records is refused", () => {
  it("refuses a squash that kept none of the branch's record lines", () => {
    const repo = repositoryWithASquashedBranch({
      branchTrailers: `${LIMIT}\n${WARN}`,
      mergeTrailers: "Blast: local",
    });
    const result = run(repo);
    expect(result.status).toBe(1);
    expect(result.out).toContain("2 record line(s) the branch carried and this merge does not keep");
    expect(result.out).toContain(LIMIT);
    expect(result.out).toContain("RESULT: FAIL");
  });

  it("a record carried only by the notes mirror is preserved", () => {
    // The sanctioned path's own shape: the message keeps the last paragraph and
    // `commitlore squash-preserve` attaches the rest as a note. Reading the message alone would
    // report this -- a correct merge -- as a loss.
    const repo = repositoryWithASquashedBranch({
      branchTrailers: `${LIMIT}\n${WARN}`,
      mergeTrailers: WARN,
      note: LIMIT,
    });
    const result = run(repo);
    expect(result.out).not.toContain("does not keep");
    expect(result.status).toBe(0);
  });

  it("a branch whose records carry no Record-Id is still measured", () => {
    // 74c37fa's shape. Counting `Record-Id` alone reported "0 record(s) on the branch" against 83
    // lines that were gone, so a guard keyed on it passes the very losses it was written for.
    const repo = repositoryWithASquashedBranch({
      branchTrailers: `${LIMIT}\n${WARN}`,
      mergeTrailers: "Blast: local",
    });
    const result = run(repo);
    expect(result.out).not.toContain("0 record line(s) on the branch");
    expect(result.status).toBe(1);
  });

  it("passes a merge that kept everything, so the cases above cannot be met by refusing always", () => {
    const repo = repositoryWithASquashedBranch({
      branchTrailers: `${LIMIT}\n${WARN}`,
      mergeTrailers: `${LIMIT}\n${WARN}`,
    });
    const result = run(repo);
    expect(result.status).toBe(0);
    expect(result.out).toContain("2 record line(s) on the branch, all reachable");
  });
});

/**
 * #1269 — a pull request merges as a merge commit. Its head is its own second parent, so the branch's
 * records are reachable as committed; what the gate checks is that the second parent is the head
 * GitHub records for the pull request, never a trailer.
 */
describe("a merge commit is checked by its parents", () => {
  /** `base-tree`: parents [base, head] as GitHub records them, with the base's tree, so the branch's changes are dropped. */
  const repositoryWithAMergeCommit = (secondParent: "head" | "other" | "base-tree") => {
    const dir = tempDir("acp-merge-commit-records-");
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    git(work, "init", "--quiet", "-b", "main");
    git(work, "config", "user.email", "test@example.invalid");
    git(work, "config", "user.name", "test");
    writeFileSync(join(work, "a.txt"), "base\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "--no-verify", "-m", "base");
    const base = git(work, "rev-parse", "HEAD").trim();
    git(work, "checkout", "--quiet", "-b", "feature");
    writeFileSync(join(work, "a.txt"), "first\n");
    git(work, "commit", "--quiet", "--no-verify", "-am", `feat: the first half\n\n${LIMIT}`);
    const first = git(work, "rev-parse", "HEAD").trim();
    writeFileSync(join(work, "a.txt"), "second\n");
    git(work, "commit", "--quiet", "--no-verify", "-am", `feat: the second half\n\n${WARN}`);
    const head = git(work, "rev-parse", "HEAD").trim();
    git(work, "checkout", "--quiet", "main");
    if (secondParent === "base-tree") {
      const dropped = git(work, "commit-tree", `${base}^{tree}`, "-p", base, "-p", head, "-m", "Merge pull request #7 from acme/feature").trim();
      git(work, "update-ref", "refs/heads/main", dropped);
    } else {
      git(work, "merge", "--quiet", "--no-ff", "--no-verify", "-m", "Merge pull request #7 from acme/feature", secondParent === "head" ? head : first);
    }
    const merge = git(work, "rev-parse", "HEAD").trim();
    git(work, "remote", "add", "origin", work);
    const env = fakeGitHub(dir, { 7: { merged: true, mergeCommit: merge, head } });
    let result: { status: number; out: string };
    try {
      result = { status: 0, out: execFileSync(process.execPath, [CHECK, `${base}..${merge}`], { cwd: work, env, encoding: "utf8", timeout: 60_000 }) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      result = { status: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
    return { ...result, head, first, merge, tree: (sha: string) => git(work, "rev-parse", `${sha}^{tree}`).trim() };
  };

  it("passes a merge commit whose second parent is the pull request's head, with the branch's records reachable through it", () => {
    const result = repositoryWithAMergeCommit("head");
    expect(result.out).toContain(`#7  2 record line(s) on 2 branch commit(s), reachable from ${result.merge.slice(0, 8)} through its second parent, #7's head ${result.head.slice(0, 8)}`);
    expect(result.out).toContain("1 merge commit(s) examined");
    expect(result.status, result.out).toBe(0);
  });

  it("refuses a merge commit whose second parent is not the pull request's head", () => {
    const result = repositoryWithAMergeCommit("other");
    expect(result.out).toContain(`its second parent ${result.first.slice(0, 8)} is not #7's head ${result.head.slice(0, 8)}`);
    expect(result.out).toContain("RESULT: FAIL");
    expect(result.status).toBe(1);
  });

  it("refuses a merge commit whose parents are the base and the pull request's head but whose tree is the base's, dropping the branch's changes", () => {
    const result = repositoryWithAMergeCommit("base-tree");
    const [mergeTree, headTree] = [result.tree(result.merge), result.tree(result.head)];
    expect(mergeTree).not.toBe(headTree);
    expect(result.out).toContain(`its tree ${mergeTree.slice(0, 8)} is not #7's head tree ${headTree.slice(0, 8)}`);
    expect(result.out).not.toContain("RESULT: PASS");
    expect(result.status, result.out).toBe(1);
  });
});
