import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
}): { readonly dir: string; readonly range: string } => {
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

  // The squash: one parent, a `(#N)` subject, and only what the merge chose to keep.
  git(work, "checkout", "--quiet", "main");
  git(work, "merge", "--quiet", "--squash", "feature");
  git(work, "commit", "--quiet", "--no-verify", "-m", `feat: the branch commit (#7)\n\n${options.mergeTrailers}`);
  const merge = git(work, "rev-parse", "HEAD").trim();
  if (options.note !== undefined) {
    writeFileSync(join(dir, "note.txt"), `${options.note}\n`);
    git(work, "notes", "--ref=commitlore", "add", "-F", join(dir, "note.txt"), merge);
  }

  // The check reaches the branch through the pull request ref, which is what survives the branch
  // being deleted. `origin` is this repository itself so the fetch it runs resolves offline.
  git(work, "update-ref", "refs/pull/7/head", head);
  git(work, "remote", "add", "origin", work);
  return { dir: work, range: `${base}..${merge}` };
};

const run = (cwd: string, range: string): { status: number; out: string } => {
  try {
    const out = execFileSync("node", [CHECK, range], { cwd, encoding: "utf8", timeout: 60_000 });
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
    const result = run(repo.dir, repo.range);
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
    const result = run(repo.dir, repo.range);
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
    const result = run(repo.dir, repo.range);
    expect(result.out).not.toContain("0 record line(s) on the branch");
    expect(result.status).toBe(1);
  });

  it("passes a merge that kept everything, so the cases above cannot be met by refusing always", () => {
    const repo = repositoryWithASquashedBranch({
      branchTrailers: `${LIMIT}\n${WARN}`,
      mergeTrailers: `${LIMIT}\n${WARN}`,
    });
    const result = run(repo.dir, repo.range);
    expect(result.status).toBe(0);
    expect(result.out).toContain("2 record line(s) on the branch, all reachable");
  });
});
