import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sha256 } from "../core/digest.ts";
import { type Decision, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  WorktreeAction,
  WriteOperation,
  type GuardRequest,
  type ManagedWriteGuard,
} from "../guard/managed-write-guard.ts";
import { canonical } from "../guard/workspace-probe.ts";

const exec = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Complete authorization carried by each ACP-owned Git mutation. */
export interface GuardedGitEffect {
  readonly guard: ManagedWriteGuard;
  readonly request: GuardRequest;
}

const authorizeGitMutation = async (
  authorization: GuardedGitEffect | undefined,
  expectedTarget: string,
  expectedAction: WorktreeAction,
  cwd: string,
  effect: () => Promise<GitResult>,
): Promise<Decision<void>> => {
  if (!authorization) {
    return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "Git worktree mutation requires guard authorization", {
      expectedTarget,
    });
  }
  if (authorization.request.operation !== WriteOperation.GIT_WORKTREE) {
    return deny(ReasonCode.INVALID_ARGUMENT, "Git worktree API requires a GIT_WORKTREE authorization", {
      operation: authorization.request.operation,
    });
  }
  if (authorization.request.worktreeAction !== expectedAction) {
    return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "Git mutation action does not match the guard request", {
      expectedAction,
      authorizedAction: authorization.request.worktreeAction ?? null,
    });
  }
  if (!authorization.request.targetPath || canonical(authorization.request.targetPath) !== canonical(expectedTarget)) {
    return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "Git mutation target does not match the guard request", {
      expectedTarget: canonical(expectedTarget),
      authorizedTarget: authorization.request.targetPath ?? null,
    });
  }
  const authorized = await authorization.guard.authorize(authorization.request, async () => {
    await effect();
  });
  return authorized;
};

/**
 * How long any one git invocation may take before it is killed.
 *
 * `maxBuffer` above bounds how much a git command may *say*; nothing bounded how long it may take.
 * `promisify(execFile)` without a `timeout` waits forever, so a git that never returns — an index
 * lock another process holds, a stalled filesystem, a credential helper waiting on a prompt that
 * has no terminal — stops the caller rather than failing it (#859).
 *
 * 120s is chosen from what this wrapper is actually used for, measured rather than guessed: every
 * call site is local. `grep` across `src/` finds rev-parse, status, diff, show, cat-file, ls-tree,
 * merge-base, symbolic-ref, remote, branch, init, add, and worktree add/remove/list/prune — and
 * **no** clone, push, pull or ls-remote. The one fetch is the self-contained verification checkout
 * (`verify/worktree.ts`), which fetches one commit from a local checkout path, not from a network.
 * So no legitimate use waits on a network, and the slowest plausible one is writing a working
 * tree (`worktree add --detach`, or that checkout's fetch and checkout).
 *
 * A caller that needs longer passes `timeoutMs`. That is the affordance a blanket bound has to
 * have: the alternative to a per-call override is picking one number large enough for the worst
 * case, which is the same as having no bound for every other case.
 *
 * The affordance has to *reach* the call this paragraph worries about, and for one release it did
 * not. `addWorktree`, `removeWorktree` and `pruneWorktrees` took no timeout and passed none, so
 * `worktree add --detach` -- the call named above as the slowest plausible one -- was the single
 * call no caller could give more time. An escape hatch nothing can open is not an answer to the
 * bound; it is the argument for the bound with its premise missing (#878).
 */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * One time bound shared by several git invocations that answer one question together (#1082
 * R3-01). `endsAt` is on the monotonic `performance.now()` clock, so a wall-clock step cannot
 * lengthen or shorten it. The bound is a logical budget: each invocation is given what remains of
 * it, none is started once it is spent, and an answer that settles after it is a timeout. How
 * promptly the operating system delivers the kill and the answer is not part of what it promises.
 */
interface GitDeadline {
  readonly boundMs: number;
  readonly endsAt: number;
}

/** A positive bound, refused at 0 or below for the reason `git()` gives. */
const positiveBound = (cwd: string, args: readonly string[], timeoutMs: number): number => {
  if (timeoutMs <= 0) {
    fail(ReasonCode.INVALID_ARGUMENT, "a git time bound must be a positive number of milliseconds", {
      cwd,
      args,
      timeoutMs,
    });
  }
  return timeoutMs;
};

const deadlineAfter = (cwd: string, timeoutMs: number | undefined): GitDeadline => {
  const boundMs = positiveBound(cwd, [], timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  return { boundMs, endsAt: performance.now() + boundMs };
};

/**
 * What remains of `deadline` for the next invocation, in whole milliseconds because that is what
 * Node's `timeout` takes. Under one millisecond is spent: Node reads `timeout: 0` as no bound at
 * all, so the next process is refused rather than started.
 */
const remainingOf = (deadline: GitDeadline, cwd: string, args: readonly string[]): number => {
  const remaining = Math.floor(deadline.endsAt - performance.now());
  if (remaining < 1) {
    fail(
      ReasonCode.GIT_TIMEOUT,
      `git ${args.join(" ")} was not started: the ${deadline.boundMs}ms bound it shares was already spent`,
      { cwd, args, timeoutMs: deadline.boundMs, started: false },
    );
  }
  return remaining;
};

/**
 * argv-only git invocation. There is no shell in the path, so no interpolation,
 * pipes or redirection can be smuggled through a branch name or path
 * (Integration §12: "기본 `sh -c`, Pipe, Redirect, Command Substitution 금지").
 */
export const git = async (
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number; isolatedConfig?: boolean; deadline?: GitDeadline } = {},
): Promise<GitResult> => {
  // `?? ` would pass a caller's `0` straight through, and Node reads `timeout: 0` as *no*
  // timeout — so the one value that removes the bound would still census as bounded, because
  // `verify-subprocess-calls-are-bounded.mjs` reads the property's presence and never its value.
  // No caller passes 0 today; this refuses the affordance rather than waiting for one to.
  const requested = options.timeoutMs;
  if (requested !== undefined) positiveBound(cwd, args, requested);
  const timeout = options.deadline
    ? remainingOf(options.deadline, cwd, args)
    : requested ?? DEFAULT_GIT_TIMEOUT_MS;
  // A settlement at or after the bound is not git answering (#1082 R3-01). Node's kill timer fires
  // only once `timeout` has elapsed since the spawn, and it destroys the output pipes before it
  // signals, so a child that outlives the signal -- one that ignores SIGTERM, or whose exit races
  // the timer -- still settles, and Node reports whatever that settlement is. Measured with a git
  // that ignored SIGTERM: one with nothing to write settled with its own exit code, 0 read as
  // success and 1 handed back by `allowFailure` as git saying no; one still writing died of
  // SIGPIPE on the destroyed pipe and read as an outside signal. `startedAt` is read before the
  // spawn, so every settlement the timer could have touched reads as at least `timeout` here.
  const startedAt = performance.now();
  const late = (): boolean => performance.now() - startedAt >= timeout;
  let settled: { stdout: string; stderr: string };
  try {
    settled = await exec("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      timeout,
      env: { ...sanitizedGitEnv(), ...(options.isolatedConfig ? ISOLATED_CONFIG_ENV : {}) },
    });
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string | null;
      signal?: string | null;
      killed?: boolean;
      message?: string;
    };
    // A timeout is not git answering. Measured: `promisify(execFile)` reports a killed-by-timeout
    // child as `{ code: null, signal: "SIGTERM", killed: true }` — note `code` is null, not
    // "ETIMEDOUT" as the synchronous family reports. So `e.code ?? 1` would have called it exit 1,
    // which is indistinguishable from git refusing, and `allowFailure` callers would have read
    // "the answer is no" where the truth is "the check could not run" (#859).
    const killedByBound = e.killed === true && e.signal === "SIGTERM" && (e.code ?? null) === null;
    // A child that outlived the signal and then exited is no answer either: its output pipes were
    // destroyed when the bound fired (#1082 R3-01). A string `code` keeps its own shape below.
    const timedOut = killedByBound || (typeof e.code !== "string" && late());
    // Measured on this repository's runtime (Node 22), the three shapes that are *not* git
    // answering:
    //
    //   timeout    { code: null,                                signal: "SIGTERM", killed: true }
    //   maxBuffer  { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", name: "RangeError" }
    //   no binary  { code: "ENOENT" }
    //
    // All three mean the check did not run, and only the first was separated. The other two have
    // a *string* `code`, so `e.code ?? 1` produced the string as an exit code and `allowFailure`
    // handed it to a caller reading `exitCode !== 0` as "git said no" — the collapse #859 exists
    // to remove, one shape narrower than before.
    // A child that produced no exit code did not answer, whatever killed it. `killed` is Node's
    // own flag for "I sent the signal", so it is **false** when launchd, systemd, an OOM kill or a
    // stray `pkill` is what ended the process — measured on Node 22 as
    // `{ code: null, signal: "SIGTERM", killed: false }`. An earlier version of this file tested
    // `killed` and so classified that shape as git answering, then manufactured `exitCode: 1` for
    // it, which is the value `git status --porcelain` uses to say *no*. A merge-gate review
    // reproduced the whole collapse from there.
    const signalled = (e.code ?? null) === null;
    const didNotRun = timedOut || typeof e.code === "string" || signalled;
    const detail = timedOut
      ? killedByBound
        ? `git ${args.join(" ")} exceeded its ${timeout}ms bound and was killed`
        : `git ${args.join(" ")} settled after its ${timeout}ms bound, so its answer is not counted`
      : typeof e.code === "string"
        ? `git ${args.join(" ")} did not run: ${e.code}`
        : signalled
          ? `git ${args.join(" ")} was killed by ${e.signal ?? "an unknown signal"} without answering`
          : `git ${args.join(" ")} failed: ${e.stderr ?? e.message}`;
    if (options.allowFailure && !didNotRun) {
      // Reached only when `e.code` really is a number, so nothing is synthesized here.
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", exitCode: e.code as number };
    }
    return fail(timedOut ? ReasonCode.GIT_TIMEOUT : ReasonCode.INTERNAL_ERROR, detail, {
      cwd,
      args,
      // No `exitCode` unless the child produced one. Three shapes, three distinct evidence keys,
      // so a reader can tell "git answered" from "git did not" structurally rather than by the
      // presence of a number this function invented.
      ...(timedOut
        ? { timeoutMs: timeout }
        : typeof e.code === "string"
          ? { failureCode: e.code }
          : signalled
            ? { signal: e.signal ?? null }
            : { exitCode: e.code as number }),
    });
  }
  if (late()) {
    return fail(
      ReasonCode.GIT_TIMEOUT,
      `git ${args.join(" ")} settled after its ${timeout}ms bound, so its answer is not counted`,
      { cwd, args, timeoutMs: timeout },
    );
  }
  return { stdout: settled.stdout, stderr: settled.stderr, exitCode: 0 };
};

/** git needs a predictable environment; the caller's locale/pager must not leak in. */
const sanitizedGitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_CONFIG_NOSYSTEM: "1",
});

/**
 * Git reading no configuration but the repository's own: not the operator's ~/.gitconfig or XDG
 * config, and not the global ignore or attributes files that live beside it. This is what the
 * verification sandbox sees (its HOME is an empty scratch directory), and it is what keeps an
 * operator-wide filter, hook path or line-ending rule from running in, or reshaping, a
 * verification checkout ACP materialises. Measured on a real operator machine: the global config
 * carried credential helpers, a required `filter.lfs` process and `core.autocrlf`.
 */
const ISOLATED_CONFIG_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  XDG_CONFIG_HOME: "/dev/null",
};

export const revParse =async (cwd: string, ref: string): Promise<string> =>
  (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();

export const tryRevParse = async (
  cwd: string,
  ref: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> => {
  const out = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], {
    allowFailure: true,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return out.exitCode === 0 ? out.stdout.trim() : null;
};

/** Exact tree object of a commit — the canonical content identity of a candidate. */
export const treeOf = async (cwd: string, ref: string): Promise<string> =>
  (await git(cwd, ["rev-parse", `${ref}^{tree}`])).stdout.trim();

export const toplevel = async (cwd: string): Promise<string> =>
  (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();

export const currentBranch = async (cwd: string): Promise<string> =>
  (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();

export const remoteUrl = async (cwd: string, remote = "origin"): Promise<string | null> => {
  const out = await git(cwd, ["remote", "get-url", remote], { allowFailure: true });
  return out.exitCode === 0 ? out.stdout.trim() : null;
};

/** `withoutRepositoryPrograms`, optionally spending a deadline the caller shares. */
const programFreeOptions = async (cwd: string, bound: { deadline?: GitDeadline }): Promise<string[]> => {
  const listed = await git(cwd, ["config", "--name-only", "--get-regexp", "^filter\\."], {
    allowFailure: true,
    ...bound,
  });
  const drivers = new Set(
    listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((key) => key.startsWith("filter.") && key.lastIndexOf(".") > "filter.".length)
      .map((key) => key.slice("filter.".length, key.lastIndexOf("."))),
  );
  return [
    "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    ...[...drivers].flatMap((driver) => [
      "-c", `filter.${driver}.smudge=`,
      "-c", `filter.${driver}.clean=`,
      "-c", `filter.${driver}.process=`,
      "-c", `filter.${driver}.required=false`,
    ]),
  ];
};

/**
 * Options that keep one git invocation from running the programs listed below, and from reading
 * replaced objects (#1082 R1-01). Every git read that prepares or judges a candidate for
 * verification takes them. The claim is exactly this list, each item measured against a real
 * program; it is not a claim that no other git setting can select a program.
 *
 * - `--no-replace-objects`: the objects the candidate commit actually names. A replace ref changes
 *   what a local read returns and nothing else.
 * - Every filter driver the configuration declares (the repository's, and the operator's global
 *   one, which is where git-lfs installs itself), emptied: `smudge`, `clean` and `process`, and
 *   `required=false` so a declared-required driver does not fail the command instead. A candidate's
 *   `.gitattributes` selects a driver by name, and `git status` runs its clean or process program
 *   as the control-plane user, outside any sandbox -- measured, a clean filter that kept the source
 *   looking clean started a writer that rewrote the gate after it had been checked. An emptied
 *   driver is no driver, so git compares and writes raw bytes. The cost: in a repository that
 *   uses LFS, a file whose stat information is stale is compared raw against its pointer and
 *   reads as modified.
 * - `core.fsmonitor=false`: the fsmonitor hook is a program the configuration names.
 * - `core.hooksPath=/dev/null`: `git status` writes the index and so runs `post-index-change`.
 *
 * These reach the repository git is run in and nothing nested in it. Status reads therefore also
 * pass `--ignore-submodules=dirty`: otherwise git runs `git status` inside every populated
 * submodule with that repository's own configuration, and that repository's fsmonitor and hooks
 * run -- measured. Patch reads pass `PATCH_WITHOUT_PROGRAMS` for the same reason.
 */
export const withoutRepositoryPrograms = async (cwd: string): Promise<string[]> => programFreeOptions(cwd, {});

/**
 * Whether the checkout has no tracked change and no untracked, non-ignored file. Read under
 * `withoutRepositoryPrograms`, so neither a candidate-selected filter nor a submodule's own
 * configuration runs anything while it is asked: snapshot freshness asks it of a candidate's source.
 * Dirt inside a populated submodule's own working tree is therefore not counted; a submodule whose
 * checked-out commit differs from the recorded one still is.
 *
 * The answer takes two git processes, configuration discovery and then status, and `timeoutMs`
 * bounds the pair, not each one (#1082 R3-01). The doctor hands this the remainder of its sweep
 * budget; when discovery ran under git's own 120s default instead, a 20ms request with discovery
 * delayed by 350ms answered after about 730ms. One deadline is taken before discovery, each process gets what is left of it,
 * status is not started once it is spent, and a process that settles after it is a timeout. With
 * no `timeoutMs`, the pair shares `git()`'s default bound.
 */
export const isClean = async (
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> => {
  const deadline = deadlineAfter(cwd, options.timeoutMs);
  const programs = await programFreeOptions(cwd, { deadline });
  const status = await git(cwd, [...programs, "status", "--porcelain", "--ignore-submodules=dirty"], { deadline });
  return status.stdout.trim().length === 0;
};

export const mergeBase = async (cwd: string, a: string, b: string): Promise<string | null> => {
  const out = await git(cwd, ["merge-base", a, b], { allowFailure: true });
  return out.exitCode === 0 ? out.stdout.trim() : null;
};

/**
 * Options every diff of a candidate takes (#1082 R1-01), so the patch is the stored bytes and no
 * program renders it.
 *
 * - `--no-ext-diff`: `diff.external`, or a `diff=<driver>` attribute's `command`, would run.
 * - `--no-textconv`: a `diff=<driver>` attribute the candidate commits selects the textconv program
 *   the repository's configuration names.
 * - `--submodule=short`: a changed gitlink is one `Subproject commit` line. A repository's
 *   `diff.submodule=diff` otherwise makes git diff the populated nested repository's two commits
 *   in a child git that reads the nested repository's own configuration, and neither option above
 *   reaches that child. Measured: the nested repository's textconv and `diff.external` programs
 *   both ran through `diffDigest`, and neither runs with this option. `short` is git's default,
 *   so a repository without that setting digests the same bytes as before.
 */
const PATCH_WITHOUT_PROGRAMS = ["--no-ext-diff", "--no-textconv", "--submodule=short"] as const;

/** Stable digest of the exact patch between two commits. */
export const diffDigest = async (cwd: string, base: string, head: string): Promise<string> => {
  const out = await git(cwd, [
    "diff",
    "--no-color",
    ...PATCH_WITHOUT_PROGRAMS,
    "--full-index",
    "--binary",
    `${base}..${head}`,
  ]);
  return sha256(out.stdout);
};

export const diffText = async (cwd: string, base: string, head: string): Promise<string> =>
  (await git(cwd, ["diff", "--no-color", ...PATCH_WITHOUT_PROGRAMS, "--full-index", `${base}..${head}`]))
    .stdout;

/**
 * The paths a candidate changes. `--name-only` renders no patch, so the options that keep a patch
 * read from running programs have nothing to act on here -- measured, a nested repository's
 * `diff.external` and textconv did not run through this read without them. They are passed anyway
 * so the read does not depend on that.
 */
export const changedPaths = async (
  cwd: string,
  base: string,
  head: string,
): Promise<string[]> => {
  const out = await git(cwd, ["diff", "--name-only", ...PATCH_WITHOUT_PROGRAMS, `${base}..${head}`]);
  return out.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
};

export const fileAt = async (cwd: string, ref: string, path: string): Promise<string | null> => {
  const out = await git(cwd, ["show", `${ref}:${path}`], { allowFailure: true });
  return out.exitCode === 0 ? out.stdout : null;
};

export const commitExists = async (cwd: string, sha: string): Promise<boolean> =>
  (await git(cwd, ["cat-file", "-e", `${sha}^{commit}`], { allowFailure: true })).exitCode === 0;

export const branchesContaining = async (cwd: string, sha: string): Promise<string[]> => {
  const out = await git(cwd, ["branch", "--all", "--contains", sha, "--format=%(refname:short)"], {
    allowFailure: true,
  });
  if (out.exitCode !== 0) return [];
  return out.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
};

export const addWorktree = async (
  cwd: string,
  path: string,
  ref: string,
  authorization?: GuardedGitEffect,
  /** `gitOptions` go before the subcommand: `--no-replace-objects` and `-c` overrides. */
  options: { timeoutMs?: number; gitOptions?: readonly string[] } = {},
): Promise<Decision<void>> => {
  return authorizeGitMutation(
    authorization,
    path,
    WorktreeAction.ADD,
    cwd,
    () => git(cwd, [...(options.gitOptions ?? []), "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, ref], {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
};

export const removeWorktree = async (
  cwd: string,
  path: string,
  authorization?: GuardedGitEffect,
  options: { timeoutMs?: number } = {},
): Promise<Decision<void>> => {
  return authorizeGitMutation(
    authorization,
    path,
    WorktreeAction.REMOVE,
    cwd,
    () => git(cwd, ["worktree", "remove", "--force", path], {
      allowFailure: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
};

/**
 * Which worktrees git knows about, or a refusal.
 *
 * This used to answer `[]` for a nonzero exit, and an empty list is not "git has no worktrees" --
 * it is "nothing was read". Every reader here decides something about the filesystem from the
 * answer, and four of the five read absence as a fact:
 *
 *   verify/worktree.ts:65   create()   -- an id already in use looks free, so the CONFLICT guard
 *                                        passes and two runs can claim one path
 *   verify/worktree.ts:133  destroy()  -- the `remaining` check certifies ISOLATION_LOST did not
 *                                        happen, having observed nothing. This was reproduced by
 *                                        a merge-gate review on a repository with two real
 *                                        worktrees: exit 128, `fatal: detected dubious ownership`,
 *                                        listing `[]`, removal "verified"
 *   verify/worktree.ts:181  orphans()  -- reports a clean root, which the doctor prints as a
 *                                        finding's absence
 *   verify/worktree.ts:111  the post-add cleanup -- skips removing a tree whose integrity check
 *                                        just failed, which is the one thing that block exists
 *                                        to prevent. That site therefore treats a refusal as
 *                                        "presence unknown" and removes anyway
 *
 * `worktree list --porcelain` exits 0 in any work tree, listing at least the main one, so a
 * nonzero exit is never the shape of an empty repository. The #869 time bound already made the
 * signal, timeout and `ENOENT` shapes throw past `allowFailure`; a genuine nonzero exit -- 128 for
 * every git fatal -- was the one that still arrived here as data.
 */
export const listWorktrees = async (cwd: string): Promise<Array<{ path: string; head: string }>> => {
  const out = await git(cwd, ["worktree", "list", "--porcelain"], { allowFailure: true });
  if (out.exitCode !== 0) {
    // No stderr in evidence: it lands in audit rows, and git's message can carry a path the
    // caller never supplied. The exit code is what distinguishes this from an empty listing.
    fail(ReasonCode.INTERNAL_ERROR, "the git worktree listing did not complete, so which worktrees exist is unknown", {
      cwd,
      exitCode: out.exitCode,
      probe: "worktree list --porcelain",
    });
  }
  const entries: Array<{ path: string; head: string }> = [];
  let path = "";
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9).trim();
    else if (line.startsWith("HEAD ")) entries.push({ path, head: line.slice(5).trim() });
  }
  return entries;
};

export const pruneWorktrees = async (
  cwd: string,
  authorization?: GuardedGitEffect,
  options: { timeoutMs?: number } = {},
): Promise<Decision<void>> => {
  return authorizeGitMutation(
    authorization,
    cwd,
    WorktreeAction.PRUNE,
    cwd,
    () => git(cwd, ["worktree", "prune"], {
      allowFailure: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
};
