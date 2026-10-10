import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { type FakePull, fakeGitHub, fakeGitHubCalls } from "../helpers/fake-github-pulls.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `scripts/verify-merge-preserved-records.mjs` attributes each `(#N)` commit from GitHub's
 * `merged` and `merge_commit_sha` for #N alone, and reads a squash's branch up to the head its own
 * `Merged-Head` trailer names. These pin, with real repositories and an offline stand-in for
 * `gh api`:
 *
 *   * 1e3ab0b7's false positive: a commit naming a pull request that is not merged, or merged as
 *     another commit, is attribution non-target, and #N's commit list is never consulted (narrow
 *     review 5 faked its completeness with a duplicated page);
 *   * a real squash that dropped a record is refused against its `Merged-Head`, whatever the pull
 *     request's movable `head.sha` says -- moved on, force-moved onto the squash, rewritten to the
 *     same tree, or rolled back over a record-only commit (narrow review 5, HEAD);
 *   * a record added to the pull request after the merge never blames the squash;
 *   * a squash with no `Merged-Head`, a duplicate, conflicting or malformed one, or one naming a
 *     commit that cannot be fetched and read, is refused as unverifiable;
 *   * a 404 is "no pull request" only with GitHub's own not-found body, and every other failed
 *     lookup (range, message, trailer parser, notes, branch, API, parse) refuses (LOOKUP).
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

/** A commit on the checked-out branch that changes nothing: the tree stays its parent's. */
const sameTreeCommit = (cwd: string, message: string): string => {
  git(cwd, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

interface World {
  readonly dir: string;
  readonly work: string;
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
  return { dir, work, base };
};

/** A squash of the branch `from` onto `onto`, with `message`; returns its sha. */
const squash = (w: World, from: string, onto: string, message: string): string => {
  git(w.work, "checkout", "--quiet", onto);
  git(w.work, "merge", "--quiet", "--squash", from);
  git(w.work, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message);
  return git(w.work, "rev-parse", "HEAD");
};

/** The paragraph `scripts/merge-pr.mjs` writes straight after the subject. */
const named = (head: string): string => `Merged-Head: ${head}`;

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

const expectNonTarget = (result: Result, sha: string, pull: number, why: string): void => {
  expect(result.out).toContain(`${sha.slice(0, 8)}  #${pull}  attribution non-target (not PR #${pull}'s squash: #${pull} ${why})`);
  expect(result.out).toContain("1 attribution non-target");
  expect(result.out).not.toContain("does not keep");
  expect(result.out).not.toContain("all reachable");
  expect(result.out).not.toContain("refused");
  expect(result.out).toContain("RESULT: PASS");
  expect(result.status, result.out).toBe(0);
};

const expectLoss = (result: Result, squashSha: string, head: string, pull = 8): void => {
  expect(result.out).toContain(`${squashSha.slice(0, 8)}  #${pull}  1 record line(s) the branch carried and this merge does not keep (the branch read up to its merge-time head ${head.slice(0, 8)})`);
  expect(result.out).toContain(LIMIT);
  expect(result.out).not.toContain("attribution non-target (");
  expect(result.status, result.out).toBe(1);
};

const expectKept = (result: Result, squashSha: string, head: string, lines: number, pull = 8): void => {
  expect(result.out).toContain(`#${pull}  ${lines} record line(s) on the branch, all reachable from ${squashSha.slice(0, 8)} (the branch read up to its merge-time head ${head.slice(0, 8)})`);
  expect(result.out).not.toContain("does not keep");
  expect(result.out).toContain("RESULT: PASS");
  expect(result.status, result.out).toBe(0);
};

const expectRefused = (result: Result, fragment: string): void => {
  expect(result.out).toContain(fragment);
  expect(result.out).toContain("refused");
  expect(result.out).not.toContain("does not keep");
  expect(result.out).not.toContain("attribution non-target (");
  expect(result.out).toContain("RESULT: FAIL");
  expect(result.status, result.out).toBe(1);
};

/** 1e3ab0b7's shape: a branch commit naming its own open pull request, then a commit with records. */
const branchCommitNamingItsPull = () => {
  const w = world();
  git(w.work, "checkout", "--quiet", "-b", "feature");
  const pin = commit(w.work, "test: pin the integrated file (#7)");
  const later = commit(w.work, `fix: the later work (#7 ITEM-03)\n\n${LIMIT}\n${WARN}`);
  const pull: FakePull = { merged: false, mergeCommit: "f".repeat(40), head: later, commits: [pin, later] };
  return { w, pin, later, pull };
};

/** #8 squashed onto main by `pnpm merge`'s shape, keeping only its last commit's record. */
const squashDroppingARecord = () => {
  const w = world();
  git(w.work, "checkout", "--quiet", "-b", "feature");
  const first = commit(w.work, `feat: the first half\n\n${LIMIT}`);
  const head = commit(w.work, `feat: the second half\n\n${WARN}`);
  const squashed = squash(w, "feature", "main", `feat: both halves (#8)\n\n${named(head)}\n\n${WARN}`);
  const pull: FakePull = { merged: true, mergeCommit: squashed, head, commits: [first, head] };
  return { w, first, head, squashed, pull, range: `${w.base}..${squashed}` };
};

describe("a commit naming a pull request it is not the squash of is attribution non-target", () => {
  it("1e3ab0b7's shape passes as non-target, because #7 is not merged", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    expectNonTarget(run(w, `${w.base}..${later}`, { 7: pull }), pin, 7, "is not merged");
  });

  it("stays non-target when the head moves on: a run of the old head and of the new one", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    const pushed = commit(w.work, "chore: pushed after the pin\n\nBlast: local");
    const moved: FakePull = { ...pull, head: pushed, commits: [pin, later, pushed] };
    expectNonTarget(run(w, `${w.base}..${later}`, { 7: moved }), pin, 7, "is not merged");
    expectNonTarget(run(w, `${w.base}..${pushed}`, { 7: moved }), pin, 7, "is not merged");
  });

  it("stays non-target when main is merged into the branch", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    git(w.work, "checkout", "--quiet", "main");
    commit(w.work, "feat: other work on main");
    git(w.work, "checkout", "--quiet", "feature");
    git(w.work, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    const merged = git(w.work, "rev-parse", "HEAD");
    expectNonTarget(run(w, `${w.base}..${merged}`, { 7: { ...pull, head: merged, commits: [pin, later, merged] } }), pin, 7, "is not merged");
  });

  it("is non-target when GitHub reports #N unmerged, even with this commit as its merge_commit_sha", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    expectNonTarget(run(w, `${w.base}..${later}`, { 7: { ...pull, merged: false, mergeCommit: pin } }), pin, 7, "is not merged");
  });

  it("stays non-target once its pull request has merged as another commit", () => {
    const { w, pin, later, pull } = branchCommitNamingItsPull();
    const squashed = squash(w, "feature", "main", `test: the whole branch (#7)\n\n${named(later)}`);
    expectNonTarget(run(w, `${w.base}..${later}`, { 7: { ...pull, merged: true, mergeCommit: squashed } }), pin, 7,
      `merged as ${squashed.slice(0, 8)}`);
  });

  it("is non-target for a follow-up that only mentions #N, where the commit list used to refuse it", () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const theirs = commit(w.work, "feat: the pull request's own work");
    git(w.work, "checkout", "--quiet", "main");
    const mention = commit(w.work, "fix: a follow-up that only mentions it (#7)");
    expectNonTarget(run(w, `${w.base}..${mention}`, { 7: { merged: false, head: theirs, commits: [theirs] } }), mention, 7, "is not merged");
  });

  it("never asks for #N's commit list, so a duplicated page that omits the head cannot attribute anything (narrow review 5, LOOKUP)", () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const pin = commit(w.work, "pin the file (#8)");
    const head = commit(w.work, `later work\n\n${LIMIT}`);
    const result = run(w, `${w.base}..${head}`, { 8: { merged: false, head, commits: [pin, pin], commitsCount: 2 } });
    expectNonTarget(result, pin, 8, "is not merged");
    const calls = fakeGitHubCalls(w.dir);
    expect(calls.map((call) => call.at(-1))).toEqual(["repos/test/repo/pulls/8"]);
  });
});

describe("a real squash that dropped a record is refused against the head its Merged-Head names", () => {
  it("as it is", () => {
    const s = squashDroppingARecord();
    expectLoss(run(s.w, s.range, { 8: s.pull }), s.squashed, s.head);
  });

  it("when the pull request's head moves on after the squash", () => {
    const s = squashDroppingARecord();
    git(s.w.work, "checkout", "--quiet", "feature");
    const pushed = commit(s.w.work, "fix: pushed after the squash");
    expectLoss(run(s.w, s.range, { 8: { ...s.pull, head: pushed } }), s.squashed, s.head);
  });

  it("when the pull request's head is force-moved onto the squash (narrow review 4, HEAD)", () => {
    const s = squashDroppingARecord();
    expectLoss(run(s.w, s.range, { 8: { ...s.pull, head: s.squashed } }), s.squashed, s.head);
  });

  it("when GitHub's head is a same-tree rewrite that drops the record's commit (narrow review 5, HEAD)", () => {
    const s = squashDroppingARecord();
    const tree = git(s.w.work, "rev-parse", `${s.head}^{tree}`);
    const rewritten = git(s.w.work, "commit-tree", tree, "-p", s.w.base, "-m", `rewritten history\n\n${WARN}`);
    expectLoss(run(s.w, s.range, { 8: { ...s.pull, head: rewritten, commits: [rewritten] } }), s.squashed, s.head);
  });

  it("when GitHub's head is rolled back over a record-only final commit, with Provenance in the squash (narrow review 5, HEAD)", () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const work = commit(w.work, `work\n\n${WARN}`);
    const head = sameTreeCommit(w.work, `decision after work\n\n${LIMIT}`);
    const squashed = squash(w, "feature", "main", `work (#8)\n\n${named(head)}\n\n${WARN}\nProvenance: inherited ${work}`);
    const range = `${w.base}..${squashed}`;
    const proven: FakePull = { merged: true, mergeCommit: squashed, head, commits: [work, head] };
    expectLoss(run(w, range, { 8: proven }), squashed, head);
    expectLoss(run(w, range, { 8: { ...proven, head: work, commits: [work] } }), squashed, head);
  });

  it("when the squash is on a release base later merged into the branch (narrow review 4, BASE)", () => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "release/next");
    const release = commit(w.work, "chore: open the release");
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const first = commit(w.work, `feat: the first half\n\n${LIMIT}`);
    const head = commit(w.work, `feat: the second half\n\n${WARN}`);
    const squashed = squash(w, "feature", "release/next", `feat: both halves (#9)\n\n${named(head)}\n\n${WARN}`);
    git(w.work, "checkout", "--quiet", "feature");
    git(w.work, "merge", "--quiet", "--no-ff", "--no-edit", "release/next");
    const moved = git(w.work, "rev-parse", "HEAD");
    expectLoss(run(w, `${release}..${squashed}`, { 9: { merged: true, mergeCommit: squashed, head: moved, commits: [first, head, moved] } }),
      squashed, head, 9);
  });
});

describe("a record added to the pull request after its merge never blames the squash", () => {
  const squashKeepingEverything = (sameTree: boolean) => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const first = commit(w.work, `feat: the first half\n\n${LIMIT}`);
    const head = commit(w.work, `feat: the second half\n\n${WARN}`);
    const squashed = squash(w, "feature", "main", `feat: both halves (#8)\n\n${named(head)}\n\n${LIMIT}\n${WARN}`);
    git(w.work, "checkout", "--quiet", "feature");
    const after = sameTree ? sameTreeCommit(w.work, `fix: after the merge\n\n${LATER}`) : commit(w.work, `fix: after the merge\n\n${LATER}`);
    return { w, first, head, squashed, after, range: `${w.base}..${squashed}` };
  };

  it.each([
    ["a same-tree record-only commit (narrow review 5, HEAD)", true],
    ["a commit that changes the tree", false],
  ] as const)("when GitHub's head is %s pushed after the merge", (_label, sameTree) => {
    const s = squashKeepingEverything(sameTree);
    const result = run(s.w, s.range, { 8: { merged: true, mergeCommit: s.squashed, head: s.after, commits: [s.first, s.head, s.after] } });
    expectKept(result, s.squashed, s.head, 2);
    expect(result.out).not.toContain(LATER);
  });
});

describe("a squash whose merge-time head cannot be established is refused as unverifiable", () => {
  /** #8's squash with `message`, every record kept, and GitHub's own head correct. */
  const squashWith = (message: (head: string, first: string) => string) => {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "feature");
    const first = commit(w.work, `feat: the first half\n\n${LIMIT}`);
    const head = commit(w.work, `feat: the second half\n\n${WARN}`);
    const squashed = squash(w, "feature", "main", message(head, first));
    return { w, head, first, squashed, run: () => run(w, `${w.base}..${squashed}`, { 8: { merged: true, mergeCommit: squashed, head, commits: [first, head] } }) };
  };

  it("and the same squash passes with its Merged-Head, so the refusals below are about the trailer", () => {
    const s = squashWith((head) => `feat: both halves (#8)\n\n${named(head)}\n\n${LIMIT}\n${WARN}`);
    expectKept(s.run(), s.squashed, s.head, 2);
  });

  it("when it carries no Merged-Head trailer", () => {
    const s = squashWith(() => `feat: both halves (#8)\n\n${LIMIT}\n${WARN}`);
    expectRefused(s.run(), `${s.squashed.slice(0, 8)} carries no Merged-Head trailer, and nothing it preserved establishes the head it was merged from — unverifiable`);
  });

  it("when it carries no Merged-Head and only Provenance names its sources, which do not bound the branch", () => {
    const s = squashWith((head, first) => `feat: both halves (#8)\n\n${LIMIT}\nProvenance: inherited ${first}\n${WARN}\nProvenance: inherited ${head}`);
    expectRefused(s.run(), "carries no Merged-Head trailer");
  });

  it("when it carries the same Merged-Head twice", () => {
    const s = squashWith((head) => `feat: both halves (#8)\n\n${named(head)}\n\n${LIMIT}\n${WARN}\n${named(head)}`);
    expectRefused(s.run(), "carries 2 duplicate Merged-Head trailers");
  });

  it("when it carries two Merged-Head trailers that disagree", () => {
    const s = squashWith((head, first) => `feat: both halves (#8)\n\n${named(head)}\n\n${named(first)}\n\n${LIMIT}\n${WARN}`);
    expectRefused(s.run(), "carries 2 conflicting Merged-Head trailers");
  });

  it("when a second declaration is spelled in another case", () => {
    const s = squashWith((head) => `feat: both halves (#8)\n\n${named(head)}\n\nmerged-head: ${head}\n\n${LIMIT}\n${WARN}`);
    expectRefused(s.run(), "carries 2 conflicting Merged-Head trailers");
  });

  it("when its Merged-Head is not one full sha", () => {
    const s = squashWith((head) => `feat: both halves (#8)\n\nMerged-Head: ${head.slice(0, 12)}\n\n${LIMIT}\n${WARN}`);
    expectRefused(s.run(), "Merged-Head trailer is not one full commit sha");
  });

  it("when its Merged-Head names a commit that cannot be fetched", () => {
    const s = squashWith(() => `feat: both halves (#8)\n\n${named("1".repeat(40))}\n\n${LIMIT}\n${WARN}`);
    expectRefused(s.run(), "could not fetch or read the commit its Merged-Head trailer names, 11111111");
  });

  /** A commit on top of `parent` with `parent`'s tree and `message`, as #8's squash. */
  const squashOnto = (w: World, parent: string, message: string) => {
    const squashed = git(w.work, "commit-tree", git(w.work, "rev-parse", `${parent}^{tree}`), "-p", parent, "-m", message);
    return { squashed, run: () => run(w, `${parent}..${squashed}`, { 8: { merged: true, mergeCommit: squashed } }) };
  };

  it("when its Merged-Head names an object that is not a commit", () => {
    const s = squashDroppingARecord();
    writeFileSync(join(s.w.dir, "blob.txt"), "not a commit\n");
    const blob = git(s.w.work, "hash-object", "-w", join(s.w.dir, "blob.txt"));
    const onBlob = squashOnto(s.w, s.squashed, `feat: names a blob (#8)\n\n${named(blob)}\n\n${WARN}`);
    expectRefused(onBlob.run(), `could not fetch or read the commit its Merged-Head trailer names, ${blob.slice(0, 8)}`);
  });

  it("when its Merged-Head is already in the squash's parent, so it names no branch", () => {
    const s = squashDroppingARecord();
    const onBase = squashOnto(s.w, s.squashed, `chore: names its own base as its head (#8)\n\n${named(s.w.base)}\n\n${WARN}`);
    expectRefused(onBase.run(),
      `${onBase.squashed.slice(0, 8)}'s Merged-Head ${s.w.base.slice(0, 8)} is already in its parent ${s.squashed.slice(0, 8)}, so it names no branch — unverifiable`);
  });
});

describe("GitHub's answer about #N attributes it, and anything that is not a valid answer refuses", () => {
  it("is not examined when GitHub answers, with its own not-found body, that #N is no pull request", () => {
    const w = world();
    const mention = commit(w.work, "fix: the thing the issue reported (#9)");
    const result = run(w, `${w.base}..${mention}`, {});
    expect(result.out).toContain(`${mention.slice(0, 8)}  #9  not examined (no PR #9)`);
    expect(result.out).toContain("RESULT: PASS");
    expect(result.status, result.out).toBe(0);
  });

  it.each([
    ["a body that does not parse (narrow review 5, LOOKUP)", { status: 404, raw: "not json" }],
    ["an empty body", { status: 404, raw: "" }],
    ["a JSON body that is not GitHub's not-found answer", { status: 404, raw: JSON.stringify({ message: "Not Found", proxy: "edge" }) }],
    ["a body with another message", { status: 404, raw: JSON.stringify({ message: "Repository moved" }) }],
    ["a body whose status disagrees", { status: 404, raw: JSON.stringify({ message: "Not Found", status: "410" }) }],
    ["an exit status gh does not give a 404", { status: 404, exitWith: 0 }],
  ] as const)("refuses a 404 with %s", (_label, broken) => {
    const w = world();
    const mention = commit(w.work, "fix: names a number (#9)");
    expectRefused(run(w, `${w.base}..${mention}`, { 9: broken }), "GitHub answered 404 for #9 without its not-found body");
  });

  it.each([
    ["a server error", { status: 502 }, "HTTP 502"],
    ["a body that does not parse", { raw: "not json" }, "could not parse pull request #7"],
    ["a failed connection", { exit: 1 }, "could not read pull request #7"],
    ["a body with no merged", { raw: JSON.stringify({ number: 7, merge_commit_sha: null }) }, "missing what this check reads"],
    ["a merged body with no merge commit", { raw: JSON.stringify({ number: 7, merged: true, merge_commit_sha: null }) }, "missing what this check reads"],
    ["a merge commit that is not a sha", { raw: JSON.stringify({ number: 7, merged: false, merge_commit_sha: "abc" }) }, "missing what this check reads"],
    ["another pull request's body", { raw: JSON.stringify({ number: 8, merged: false, merge_commit_sha: null }) }, "missing what this check reads"],
    ["a body that is not an object", { raw: "[]" }, "missing what this check reads"],
    ["a null body", { raw: "null" }, "missing what this check reads"],
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

  it("the squash's own message, where its Merged-Head is read", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: s.pull }, gitFailing(s.w, [`  "log -1 --format=%B ${s.squashed}") exit 128;;`])),
      `could not read the message of ${s.squashed.slice(0, 8)}`);
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

  it("an ancestry lookup that fails", () => {
    const s = squashDroppingARecord();
    expectRefused(run(s.w, s.range, { 8: s.pull }, gitFailing(s.w, ['  "merge-base --is-ancestor "*) exit 128;;'])),
      "could not tell whether");
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
    expectKept(run(s.w, s.range, { 8: s.pull }), s.squashed, s.head, 2);
  });
});
