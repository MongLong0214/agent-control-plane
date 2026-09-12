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
 * **no** fetch, clone, push, pull or ls-remote. So no legitimate use waits on a network, and the
 * slowest plausible one is `worktree add --detach` writing a working tree.
 *
 * A caller that needs longer passes `timeoutMs`. That is the affordance a blanket bound has to
 * have: the alternative to a per-call override is picking one number large enough for the worst
 * case, which is the same as having no bound for every other case.
 */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * argv-only git invocation. There is no shell in the path, so no interpolation,
 * pipes or redirection can be smuggled through a branch name or path
 * (Integration §12: "기본 `sh -c`, Pipe, Redirect, Command Substitution 금지").
 */
export const git = async (
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<GitResult> => {
  // `?? ` would pass a caller's `0` straight through, and Node reads `timeout: 0` as *no*
  // timeout — so the one value that removes the bound would still census as bounded, because
  // `verify-subprocess-calls-are-bounded.mjs` reads the property's presence and never its value.
  // No caller passes 0 today; this refuses the affordance rather than waiting for one to.
  const requested = options.timeoutMs;
  if (requested !== undefined && requested <= 0) {
    fail(ReasonCode.INVALID_ARGUMENT, "a git time bound must be a positive number of milliseconds", {
      cwd,
      args,
      timeoutMs: requested,
    });
  }
  const timeout = requested ?? DEFAULT_GIT_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await exec("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      timeout,
      env: { ...sanitizedGitEnv() },
    });
    return { stdout, stderr, exitCode: 0 };
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
    const timedOut = e.killed === true && e.signal === "SIGTERM" && (e.code ?? null) === null;
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
      ? `git ${args.join(" ")} exceeded its ${timeout}ms bound and was killed`
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

export const revParse = async (cwd: string, ref: string): Promise<string> =>
  (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();

export const tryRevParse = async (cwd: string, ref: string): Promise<string | null> => {
  const out = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
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

export const isClean = async (cwd: string): Promise<boolean> =>
  (await git(cwd, ["status", "--porcelain"])).stdout.trim().length === 0;

export const mergeBase = async (cwd: string, a: string, b: string): Promise<string | null> => {
  const out = await git(cwd, ["merge-base", a, b], { allowFailure: true });
  return out.exitCode === 0 ? out.stdout.trim() : null;
};

/** Stable digest of the exact patch between two commits. */
export const diffDigest = async (cwd: string, base: string, head: string): Promise<string> => {
  const out = await git(cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--full-index",
    "--binary",
    `${base}..${head}`,
  ]);
  return sha256(out.stdout);
};

export const diffText = async (cwd: string, base: string, head: string): Promise<string> =>
  (await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--full-index", `${base}..${head}`]))
    .stdout;

export const changedPaths = async (
  cwd: string,
  base: string,
  head: string,
): Promise<string[]> => {
  const out = await git(cwd, ["diff", "--name-only", `${base}..${head}`]);
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
): Promise<Decision<void>> => {
  return authorizeGitMutation(
    authorization,
    path,
    WorktreeAction.ADD,
    cwd,
    () => git(cwd, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, ref]),
  );
};

export const removeWorktree = async (
  cwd: string,
  path: string,
  authorization?: GuardedGitEffect,
): Promise<Decision<void>> => {
  return authorizeGitMutation(
    authorization,
    path,
    WorktreeAction.REMOVE,
    cwd,
    () => git(cwd, ["worktree", "remove", "--force", path], { allowFailure: true }),
  );
};

export const listWorktrees = async (cwd: string): Promise<Array<{ path: string; head: string }>> => {
  const out = await git(cwd, ["worktree", "list", "--porcelain"], { allowFailure: true });
  if (out.exitCode !== 0) return [];
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
): Promise<Decision<void>> => {
  return authorizeGitMutation(
    authorization,
    cwd,
    WorktreeAction.PRUNE,
    cwd,
    () => git(cwd, ["worktree", "prune"], { allowFailure: true }),
  );
};
