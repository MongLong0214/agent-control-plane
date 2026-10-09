import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { type FakePull, fakeGitHub } from "../helpers/fake-github-pulls.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `scripts/verify-merge-preserved-records.mjs` attributes each `(#N)` commit from GitHub's answer
 * about #N, and reads a squash's branch only up to the head it squashed. These pin, with real
 * repositories and an offline stand-in for `gh api`:
 *
 *   * 1e3ab0b7's false positive: a branch commit naming its own pull request is skipped, however
 *     that pull request's head moves;
 *   * a real squash that dropped a record is refused, including after the pull request's head is
 *     force-moved onto the squash (narrow review 4, HEAD) and when the squash lives on a release base
 *     later merged into the branch (BASE);
 *   * a record added to the pull request after the merge never blames the squash;
 *   * a merge-time head that cannot be established, a commit that is neither #N's squash nor its
 *     commit, and every failed lookup (range, message, trailer parser, notes, branch, API, list)
 *     refuse (LOOKUP); a number GitHub answers is no pull request is not examined.
 *
 * Each world also publishes `refs/pull/N/head` where the scenario puts it, as GitHub would, so the
 * same worlds judge the earlier versions of the gate that read that ref.
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
  const dir = tempDir("acp-merge-records-pulls-");
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  git(dir, "init", "--quiet", "-b", "main", work);
  const base = commit(work, "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "--no-verify", "origin", "main");
  return { dir, work, origin, base };
};

const publish = (w: World, sha: string, ref: string): void => {
  git(w.work, "push", "--quiet", "--no-verify", "--force", "origin", `${sha}:${ref}`);
};
const publishPull = (w: World, pull: number, sha: string): void => publish(w, sha, `refs/pull/${pull}/head`);

/** A squash of the branch `from` onto `onto`, with `message`; returns its sha. */
const squash = (w: World, from: string, onto: string, message: string): string => {
  git(w.work, "checkout", "--quiet", onto);
  git(w.work, "merge", "--quiet", "--squash", from);
  git(w.work, "commit", "--quiet", "--no-verify", "-m", message);
  return git(w.work, "rev-parse", "HEAD");
};

interface Result { status: number; out: string }

const run = (w: World, range: string, pulls: Readonly<Record<number, FakePull>>, base: NodeJS.ProcessEnv = process.env): Result => {
  const env = fakeGitHub(w.dir, pulls, base);
  try {
    const out = execFileSync(process.execPath, [CHECK, range], { cwd: w.work, env, encoding: "utf8", timeout: 60_000 });
    return { status: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
};

/** An environment whose `git` fails the calls `cases` match (sh `case` patterns over "$*"). */
const gitFailing = (w: World, cases: readonly string[]): NodeJS.ProcessEnv => {
  const bin = join(w.dir, "bin");
  mkdirSync(bin, { recursive: true });
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8", timeout: 10_000 }).trim();
  writeFileSync(join(bin, "git"), ["#!/bin/sh", 'case "$*" in', ...cases, "esac", `exec '${real}' "$@"`, ""].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` };
};

const LIMIT = "Limit: the branch said something the diff cannot show";
const WARN = "Warn: and something for whoever touches it next";
const LATER = "Blast: a record added to the pull request after it merged";

const expectSkipped = (result: Result, pin: string, pull = 7): void => {
  expect(result.out).toContain(`${pin.slice(0, 8)}  skipped: branch commit of #${pull}, not a squash`);
  expect(result.out).not.toContain("does not keep");
  expect(result.out).not.toContain("refused");
  expect(result.status, result.out).toBe(0);
};

const expectLoss = (result: Result, squashSha: string, pull = 8): void => {
  expect(result.out).toContain(`${squashSha.slice(0, 8)}  #${pull}  1 record line(s) the branch carried and this merge does not keep`);
  expect(result.out).toContain(LIMIT);
  expect(result.out).not.toContain("skipped");
  expect(result.status, result.out).toBe(1);
};

const expectRefused = (result: Result, fragment: string): void => {
  expect(result.out).toContain(fragment);
  expect(result.out).toContain("refused");
  expect(result.out).not.toContain("skipped");
  expect(result.out).toContain("RESULT: FAIL");
  expect(result.status, result.out).toBe(1);
};

/** 1e3ab0b7's shape: a branch commit naming its own open pull request, then a commit with records. */
const branchCommitNamingItsPull = () => {
  const w = world();
  git(w.work, "checkout", "--quiet", "-b", "feature");
  const pin = commit(w.work, "test: pin the integrated file (#7)");
  const later = commit(w.work, `fix: the later work (#7 ITEM-03)\n\n${LIMIT}\n${WARN}`);
  publishPull(w, 7, later);
  const pull: FakePull = { merged: false, head: later, commits: [pin, later] };
  return { w, pin, later, pull };
};

/** A squash of #8 on main that keeps only its last commit's record. */
const squashDroppingARecord = () => {
  const w = world();
  git(w.work, "checkout", "--quiet", "-b", "feature");
  const first = commit(w.work, `feat: the first half\n\n${LIMIT}`);
  const head = commit(w.work, `feat: the second half\n\n${WARN}`);
  publishPull(w, 8, head);
  const squashed = squash(w, "feature", "main", `feat: both halves (#8)\n\n${WARN}`);
  publish(w, squashed, "refs/heads/main");
  const pull: FakePull = { merged: true, mergeCommit: squashed, head, commits: [first, head] };
  return { w, first, head, squashed, pull, range: `${w.base}..${squashed}` };
};

describe("a branch commit that names its own pull request is not a squash", () => {
  it("1e3ab0b7's shape passes, and says it skipped a branch commit", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    expectSkipped(run(w, `${w.base}..${later}`, { 7: pull }), pin);
  });

  it("stays skipped when the head moves on: a run of the old head and of the new one", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    const pushed = commit(w.work, "chore: pushed after the pin\n\nBlast: local");
    publishPull(w, 7, pushed);
    const moved: FakePull = { ...pull, head: pushed, commits: [pin, later, pushed] };
    expectSkipped(run(w, `${w.base}..${later}`, { 7: moved }), pin);
    expectSkipped(run(w, `${w.base}..${pushed}`, { 7: moved }), pin);
  });

  it("stays skipped when main is merged into the branch", () => {
    const { w, pin, later } = branchCommitNamingItsPull();
    git(w.work, "checkout", "--quiet", "main");
    commit(w.work, "feat: other work on main");
    publish(w, "main", "refs/heads/main");
    git(w.work, "checkout", "--quiet", "feature");
    git(w.work, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    const merged = git(w.work, "rev-parse", "HEAD");
    publishPull(w, 7, merged);
    expectSkipped(run(w, `${w.base}..${merged}`, { 7: { merged: false, head: merged, commits: [pin, later, merged] } }), pin);
  });

  it("stays skipped once its pull request has merged as another commit", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    const squashed = squash(w, "feature", "main", "test: the whole branch (#7)");
    const result = run(w, `${w.base}..${later}`, { 7: { ...pull, merged: true, mergeCommit: squashed } });
    expectSkipped(result, pin);
    expect(result.out).toContain(`merged as ${squashed.slice(0, 8)}`);
  });
});

describe("a real squash that dropped a record is still refused", () => {
  it("as it is", () => {
    const s = squashDroppingARecord();
    expectLoss(run(s.w, s.range, { 8: s.pull }), s.squashed);
  });

  it("when the head moves on after the squash", () => {
    const s = squashDroppingARecord();
    git(s.w.work, "checkout", "--quiet", "feature");
    publishPull(s.w, 8, commit(s.w.work, "fix: pushed after the squash"));
    expectLoss(run(s.w, s.range, { 8: s.pull }), s.squashed);
  });

  it("when the head is force-moved onto the squash (narrow review 4, HEAD)", () => {
    const s = squashDroppingARecord();
    publishPull(s.w, 8, s.squashed);
    expectLoss(run(s.w, s.range, { 8: s.pull }), s.squashed);
  });

  it("when the head GitHub names already contains the squash, the head cannot be established", () => {
    const s = squashDroppingARecord();
    publishPull(s.w, 8, s.squashed);
    expectRefused(run(s.w, s.range, { 8: { ...s.pull, head: s.squashed } }), "merge-time head cannot be established");
  });

  it("when the squash is on a release base later merged into the branch (narrow review 4, BASE)", () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "release/next");
    const release = commit(w.work, "chore: open the release");
    publish(w, release, "refs/heads/release/next");
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const first = commit(w.work, `feat: the first half\n\n${LIMIT}`);
    const head = commit(w.work, `feat: the second half\n\n${WARN}`);
    publishPull(w, 9, head);
    const squashed = squash(w, "feature", "release/next", `feat: both halves (#9)\n\n${WARN}`);
    publish(w, squashed, "refs/heads/release/next");
    git(w.work, "checkout", "--quiet", "feature");
    git(w.work, "merge", "--quiet", "--no-ff", "--no-edit", "release/next");
    publishPull(w, 9, git(w.work, "rev-parse", "HEAD"));
    expectLoss(run(w, `${release}..${squashed}`, { 9: { merged: true, mergeCommit: squashed, head, commits: [first, head] } }), squashed, 9);
  });
});

describe("a record added to the pull request after its merge never blames the squash", () => {
  const squashKeepingEverything = () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const first = commit(w.work, `feat: the first half\n\n${LIMIT}`);
    const head = commit(w.work, `feat: the second half\n\n${WARN}`);
    const squashed = squash(w, "feature", "main", `feat: both halves (#8)\n\n${LIMIT}\n${WARN}`);
    publish(w, squashed, "refs/heads/main");
    git(w.work, "checkout", "--quiet", "feature");
    const after = commit(w.work, `fix: after the merge\n\n${LATER}`);
    publishPull(w, 8, after);
    return { w, first, head, squashed, after, range: `${w.base}..${squashed}` };
  };

  it("reads the branch only up to the head it squashed", () => {
    const s = squashKeepingEverything();
    const result = run(s.w, s.range, { 8: { merged: true, mergeCommit: s.squashed, head: s.head, commits: [s.first, s.head] } });
    expect(result.out).toContain(`#8  2 record line(s) on the branch, all reachable from ${s.squashed.slice(0, 8)} (the branch read up to its merge-time head ${s.head.slice(0, 8)})`);
    expect(result.out).not.toContain(LATER);
    expect(result.status, result.out).toBe(0);
  });

  it("refuses as unverifiable, without blaming, when GitHub names the moved head", () => {
    const s = squashKeepingEverything();
    const result = run(s.w, s.range, { 8: { merged: true, mergeCommit: s.squashed, head: s.after, commits: [s.first, s.head, s.after] } });
    expectRefused(result, `${s.after.slice(0, 8)}, the head GitHub names, does not merge into`);
    expect(result.out).not.toContain("does not keep");
  });
});

describe("a squash whose merge-time head cannot be established is refused", () => {
  it("when the head GitHub names cannot be fetched", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: { ...s.pull, head: "1".repeat(40) } }), "could not fetch the head GitHub names for #8");
  });

  it("when the head GitHub names does not merge into the squash's tree", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: { ...s.pull, head: s.first } }), "does not merge into");
  });

  it("when the squash's records name a source that is not on that head", () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const head = commit(w.work, `feat: the work\n\n${WARN}`);
    const squashed = squash(w, "feature", "main", `feat: the work (#8)\n\n${WARN}\nProvenance: inherited ${w.base}`);
    publishPull(w, 8, head);
    expectRefused(run(w, `${w.base}..${squashed}`, { 8: { merged: true, mergeCommit: squashed, head, commits: [head] } }),
      `inherits records from ${w.base.slice(0, 8)}`);
  });
});

describe("a commit naming a pull request is attributed from GitHub, or refused", () => {
  it("is not examined when GitHub answers that #N is no pull request", () => {
    const w = world();
    const named = commit(w.work, "fix: the thing the issue reported (#9)");
    const result = run(w, `${w.base}..${named}`, {});
    expect(result.out).toContain(`${named.slice(0, 8)}  #9  not examined (no PR #9`);
    expect(result.out).toContain("RESULT: PASS");
    expect(result.status, result.out).toBe(0);
  });

  it("refuses a commit that is neither #N's squash nor one of its commits", () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const theirs = commit(w.work, "feat: the pull request's own work");
    publishPull(w, 7, theirs);
    git(w.work, "checkout", "--quiet", "main");
    const named = commit(w.work, "fix: a follow-up that only mentions it (#7)");
    expectRefused(run(w, `${w.base}..${named}`, { 7: { merged: false, head: theirs, commits: [theirs] } }), "attribution failed");
  });

  it.each([
    ["a server error", { status: 502 }, "HTTP 502"],
    ["a body that does not parse", { raw: "not json" }, "could not parse pull request #7"],
    ["a failed connection", { exit: 1 }, "could not read pull request #7"],
    ["a failed commit list", { commitsFail: true }, "could not list the commits of #7"],
    ["an incomplete commit list", { commitsCount: 3 }, "the list is incomplete"],
  ] as const)("refuses on %s from GitHub", (_label, broken, fragment) => {
    const { w, later, pull } = branchCommitNamingItsPull();
    expectRefused(run(w, `${w.base}..${later}`, { 7: { ...pull, ...broken } }), fragment);
  });
});

describe("a lookup that fails refuses, never reads as empty evidence", () => {
  it("a range that cannot be resolved", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, `${"0".repeat(39)}1..${s.squashed}`, { 8: s.pull }), "could not be read");
  });

  it("a range enumeration that fails", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: s.pull }, gitFailing(s.w, ['  "rev-list --no-merges "*) exit 128;;'])),
      "could not be read");
  });

  it("a branch commit's message that cannot be read", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: s.pull }, gitFailing(s.w, [`  "log -1 --format=%B ${s.first}") exit 128;;`])),
      `could not read the message of ${s.first.slice(0, 8)}`);
  });

  it("a branch enumeration that fails", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: s.pull }, gitFailing(s.w, ['  "rev-list "[0-9a-f]*) exit 128;;'])),
      "could not read #8's branch");
  });

  it("a trailer parser that fails", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: s.pull }, gitFailing(s.w, ['  "interpret-trailers --parse") exit 128;;'])),
      "could not read the trailers of");
  });

  it("notes that cannot be listed", () => {
    const s = squashDroppingARecord();
    git(s.w.work, "notes", "--ref=commitlore", "add", "-m", LIMIT, s.squashed);
    expectRefused(run(s.w, s.range, { 8: s.pull }, gitFailing(s.w, ['  "notes --ref=commitlore list") exit 128;;'])),
      "could not read the commitlore notes");
  });

  it("and the same squash passes once its record is carried by a note, so these do not refuse always", () => {
    const s = squashDroppingARecord();
    git(s.w.work, "notes", "--ref=commitlore", "add", "-m", LIMIT, s.squashed);
    const result = run(s.w, s.range, { 8: s.pull });
    expect(result.out).toContain(`#8  2 record line(s) on the branch, all reachable from ${s.squashed.slice(0, 8)} (the branch read up to its merge-time head ${s.head.slice(0, 8)})`);
    expect(result.status, result.out).toBe(0);
  });
});
