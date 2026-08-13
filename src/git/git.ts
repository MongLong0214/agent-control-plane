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
 * argv-only git invocation. There is no shell in the path, so no interpolation,
 * pipes or redirection can be smuggled through a branch name or path
 * (Integration §12: "기본 `sh -c`, Pipe, Redirect, Command Substitution 금지").
 */
export const git = async (
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): Promise<GitResult> => {
  try {
    const { stdout, stderr } = await exec("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      env: { ...sanitizedGitEnv() },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (options.allowFailure) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", exitCode: e.code ?? 1 };
    }
    return fail(ReasonCode.INTERNAL_ERROR, `git ${args.join(" ")} failed: ${e.stderr ?? e.message}`, {
      cwd,
      args,
      exitCode: e.code ?? 1,
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
