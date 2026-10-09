import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `scripts/verify-merge-preserved-records.mjs` read every single-parent `(#N)` commit as #N's
 * squash. 1e3ab0b7, an ordinary commit on #1070's branch whose subject ended "(#1070)", was refused
 * for "dropping" the records of 04412845, a commit made after it on the same branch. These pin the
 * correction from both sides:
 *
 *   * a branch commit that names its own pull request is skipped, and stays skipped when the head
 *     moves or the base is merged in;
 *   * a real squash that dropped a record is refused before and after, including when the pull
 *     request's head moves, is force-moved, or has the base merged into it -- the cases where the
 *     squash itself becomes an ancestor of the head and ancestry alone would skip it;
 *   * a subject naming an issue, which the remote answers has no pull request ref, is not examined;
 *   * a question the gate cannot answer refuses: a remote that cannot be asked, a ref that cannot be
 *     fetched, a ref that names no commit, an origin `HEAD` that cannot be read, a failed ancestry
 *     lookup.
 *
 * Each repository has a bare `origin`, so the fetches the gate makes resolve offline.
 */
const CHECK = join(process.cwd(), "scripts", "verify-merge-preserved-records.mjs");

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", timeout: 30_000 }).trim();

let files = 0;
const commit = (cwd: string, message: string): string => {
  files += 1;
  writeFileSync(join(cwd, `file-${files}.txt`), `${message}\n`);
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "--no-verify", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

interface World {
  readonly dir: string;
  readonly work: string;
  readonly origin: string;
  readonly base: string;
}

const world = (): World => {
  const dir = tempDir("acp-merge-records-branch-");
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  git(dir, "init", "--quiet", "-b", "main", work);
  const base = commit(work, "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "--no-verify", "origin", "main");
  return { dir, work, origin, base };
};

const publishPull = (w: World, pull: number, sha: string): void => {
  git(w.work, "push", "--quiet", "--no-verify", "--force", "origin", `${sha}:refs/pull/${pull}/head`);
};
const publishMain = (w: World): void => {
  git(w.work, "push", "--quiet", "--no-verify", "--force", "origin", "main:main");
};

const run = (w: World, range: string, env: NodeJS.ProcessEnv = process.env): { status: number; out: string } => {
  try {
    const out = execFileSync(process.execPath, [CHECK, range], { cwd: w.work, env, encoding: "utf8", timeout: 60_000 });
    return { status: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
};

const LIMIT = "Limit: the branch said something the diff cannot show";
const WARN = "Warn: and something for whoever touches it next";

/** 1e3ab0b7's shape: a branch commit naming its own pull request, then a later commit with records. */
const branchCommitNamingItsPull = () => {
  const w = world();
  git(w.work, "checkout", "--quiet", "-b", "feature");
  const pin = commit(w.work, "test: pin the integrated file (#7)");
  const later = commit(w.work, `fix: the later work (#7 ITEM-03)\n\n${LIMIT}\n${WARN}`);
  publishPull(w, 7, later);
  return { ...w, pin, later };
};

const expectSkipped = (result: { status: number; out: string }, pin: string): void => {
  expect(result.out).toContain(`${pin.slice(0, 8)}  skipped: branch commit of #7, not a squash`);
  expect(result.out).not.toContain("does not keep");
  expect(result.status, result.out).toBe(0);
};

/** A real squash of #8 on main that keeps only the last commit's records. */
const squashDroppingARecord = () => {
  const w = world();
  git(w.work, "checkout", "--quiet", "-b", "feature");
  commit(w.work, `feat: the first half\n\n${LIMIT}`);
  const head = commit(w.work, `feat: the second half\n\n${WARN}`);
  publishPull(w, 8, head);
  git(w.work, "checkout", "--quiet", "main");
  git(w.work, "merge", "--quiet", "--squash", "feature");
  git(w.work, "commit", "--quiet", "--no-verify", "-m", `feat: both halves (#8)\n\n${WARN}`);
  const squash = git(w.work, "rev-parse", "HEAD");
  publishMain(w);
  return { ...w, head, squash, range: `${w.base}..${squash}` };
};

const expectLoss = (result: { status: number; out: string }, squash: string): void => {
  expect(result.out).toContain(`${squash.slice(0, 8)}  #8  1 record line(s) the branch carried and this merge does not keep`);
  expect(result.out).toContain(LIMIT);
  expect(result.out).not.toContain("skipped");
  expect(result.status, result.out).toBe(1);
};

describe("a branch commit that names its own pull request is not a squash", () => {
  it("1e3ab0b7's shape passes, and says it skipped a branch commit", () => {
    const w = branchCommitNamingItsPull();
    expectSkipped(run(w, `${w.base}..${w.later}`), w.pin);
  });

  it("stays skipped when the head moves on: a run of the old head and of the new one", () => {
    const w = branchCommitNamingItsPull();
    const pushed = commit(w.work, `chore: pushed after the pin\n\nBlast: local`);
    publishPull(w, 7, pushed);
    expectSkipped(run(w, `${w.base}..${w.later}`), w.pin);
    expectSkipped(run(w, `${w.base}..${pushed}`), w.pin);
  });

  it("stays skipped when the head is force-moved and the pin is still on it", () => {
    const w = branchCommitNamingItsPull();
    git(w.work, "commit", "--quiet", "--no-verify", "--amend", "-m", `fix: the later work, rewritten (#7 ITEM-03)\n\n${LIMIT}`);
    const rewritten = git(w.work, "rev-parse", "HEAD");
    publishPull(w, 7, rewritten);
    expectSkipped(run(w, `${w.base}..${rewritten}`), w.pin);
    expectSkipped(run(w, `${w.base}..${w.later}`), w.pin);
  });

  it("stays skipped when main is merged into the branch", () => {
    const w = branchCommitNamingItsPull();
    git(w.work, "checkout", "--quiet", "main");
    commit(w.work, "feat: other work on main");
    publishMain(w);
    git(w.work, "checkout", "--quiet", "feature");
    git(w.work, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    const merged = git(w.work, "rev-parse", "HEAD");
    publishPull(w, 7, merged);
    expectSkipped(run(w, `${w.base}..${merged}`), w.pin);
  });
});

describe("a real squash that dropped a record is still refused", () => {
  it("as it is", () => {
    const s = squashDroppingARecord();
    expectLoss(run(s, s.range), s.squash);
  });

  it("when the head moves on after the squash", () => {
    const s = squashDroppingARecord();
    git(s.work, "checkout", "--quiet", "feature");
    publishPull(s, 8, commit(s.work, "fix: pushed after the squash"));
    expectLoss(run(s, s.range), s.squash);
  });

  it("when main, carrying the squash, is merged into the branch, so the squash is an ancestor of the head", () => {
    const s = squashDroppingARecord();
    git(s.work, "checkout", "--quiet", "feature");
    git(s.work, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    const merged = git(s.work, "rev-parse", "HEAD");
    publishPull(s, 8, merged);
    expect(git(s.work, "merge-base", "--is-ancestor", s.squash, merged)).toBe("");
    expectLoss(run(s, s.range), s.squash);
  });

  it("when the head is force-moved onto main, the squash on its first-parent line", () => {
    const s = squashDroppingARecord();
    git(s.work, "checkout", "--quiet", "-B", "feature", "main");
    commit(s.work, `feat: the first half, again\n\n${LIMIT}`);
    const rebased = commit(s.work, `feat: the second half, again\n\n${WARN}`);
    publishPull(s, 8, rebased);
    expect(git(s.work, "rev-list", "--first-parent", rebased)).toContain(s.squash);
    expectLoss(run(s, s.range), s.squash);
  });

  it("when the head is force-moved to a rewritten branch off the old base", () => {
    const s = squashDroppingARecord();
    git(s.work, "checkout", "--quiet", "-B", "feature", s.base);
    commit(s.work, `feat: the first half, rewritten\n\n${LIMIT}`);
    publishPull(s, 8, commit(s.work, `feat: the second half, rewritten\n\n${WARN}`));
    expectLoss(run(s, s.range), s.squash);
  });
});

/** An environment whose `git` fails the calls `cases` match (sh `case` patterns over "$*"). */
const gitFailing = (w: World, cases: readonly string[]): NodeJS.ProcessEnv => {
  const bin = join(w.dir, "bin");
  mkdirSync(bin);
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8", timeout: 10_000 }).trim();
  writeFileSync(join(bin, "git"), ["#!/bin/sh", 'case "$*" in', ...cases, "esac", `exec '${real}' "$@"`, ""].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` };
};

const expectRefused = (result: { status: number; out: string }, line: string): void => {
  expect(result.out).toContain(line);
  expect(result.out).not.toContain("skipped");
  expect(result.out).not.toContain("not examined (no PR");
  expect(result.status, result.out).toBe(1);
};

describe("a subject naming an issue is not a pull request", () => {
  it("is not examined when the remote answers that it has no such pull request ref", () => {
    const w = world();
    const named = commit(w.work, "fix: the thing the issue reported (#9)");
    publishMain(w);
    const result = run(w, `${w.base}..${named}`);
    expect(result.out).toContain(`${named.slice(0, 8)}  #9  not examined (no PR #9 on the remote)`);
    expect(result.out).toContain("RESULT: PASS");
    expect(result.status, result.out).toBe(0);
  });
});

describe("a question the gate cannot answer refuses, never skips", () => {
  it("a remote that cannot be reached", () => {
    const w = branchCommitNamingItsPull();
    git(w.work, "remote", "set-url", "origin", join(w.dir, "no-such-remote.git"));
    expectRefused(run(w, `${w.base}..${w.later}`),
      `${w.pin.slice(0, 8)}  #7  could not ask the remote for refs/pull/7/head — refused`);
  });

  it("an ls-remote that succeeds without naming the ref", () => {
    const w = branchCommitNamingItsPull();
    const env = gitFailing(w, ['  "ls-remote --exit-code origin refs/pull/"*) exit 0;;']);
    expectRefused(run(w, `${w.base}..${w.later}`, env),
      `${w.pin.slice(0, 8)}  #7  could not ask the remote for refs/pull/7/head — refused`);
  });

  it("a fetch that fails after the remote listed the ref", () => {
    const w = branchCommitNamingItsPull();
    const env = gitFailing(w, ['  "fetch --no-tags --force origin +refs/pull/"*) exit 128;;']);
    expectRefused(run(w, `${w.base}..${w.later}`, env),
      `${w.pin.slice(0, 8)}  #7  could not fetch refs/pull/7/head — refused`);
  });

  it("a pull request ref that names no commit", () => {
    const w = branchCommitNamingItsPull();
    const tree = git(w.origin, "mktree");
    git(w.origin, "update-ref", "refs/pull/7/head", tree);
    expectRefused(run(w, `${w.base}..${w.later}`),
      `${w.pin.slice(0, 8)}  #7  could not tell whether it is an ancestor of refs/pull/7/head — refused`);
  });

  it("an origin HEAD that cannot be read", () => {
    const w = branchCommitNamingItsPull();
    git(w.origin, "symbolic-ref", "HEAD", "refs/heads/gone");
    expectRefused(run(w, `${w.base}..${w.later}`),
      `${w.pin.slice(0, 8)}  #7  an ancestor of refs/pull/7/head, and origin's HEAD could not be read`);
  });

  it("an ancestry lookup against origin's HEAD that fails", () => {
    const w = branchCommitNamingItsPull();
    const env = gitFailing(w, ['  "merge-base --is-ancestor "*" refs/merge-audit/base") exit 128;;']);
    expectRefused(run(w, `${w.base}..${w.later}`, env),
      `${w.pin.slice(0, 8)}  #7  an ancestor of refs/pull/7/head, and origin's HEAD could not be read`);
  });
});
