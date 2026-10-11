import { AsyncLocalStorage } from "node:async_hooks";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { git } from "../git/git.ts";
import type { GitHubClient } from "../github/github-kernel.ts";
import {
  createGitHubApiWritePort,
  GhCliGitHubClient,
  type GitHubWritePort,
  type GitRunner,
} from "./github-write-port.ts";

/**
 * #246 C3, review 1076-R2 — the check made at the moment a GitHub write request starts.
 *
 * The runner asks its authority before calling a port method, but a port method can await reads of
 * its own before it writes: the production `createRepository` reads the owner, and for a user
 * account the authenticated user, before its POST. Authority lost during those reads must stop the
 * POST. So the production port is composed over a client and a git runner that ask, synchronously,
 * immediately before every mutating request — a POST, PATCH, PUT or DELETE, or a git push — after
 * every read the method made, with no await between the question and the request's start.
 *
 * The question is the one the attempt in whose call chain the request is made attached, through
 * async context: each attempt carries its own. A mutating request made outside any attempt is refused.
 */
export interface BootstrapWriteRequest {
  readonly kind: "api" | "git";
  readonly method: string;
  readonly target: string;
}

export interface BootstrapWriteGuard {
  /** Throws, refusing the request, unless the attempt's authority still holds. */
  beforeRequest(request: BootstrapWriteRequest): void;
}

const attemptGuard = new AsyncLocalStorage<BootstrapWriteGuard>();

/** Runs an attempt's production with `guard` asked before each of its mutating requests. */
export const runUnderWriteGuard = <T>(guard: BootstrapWriteGuard, work: () => Promise<T>): Promise<T> =>
  attemptGuard.run(guard, work);

/**
 * #246 C5, review C5I-R1-02 — whether the caller runs in a bootstrap attempt's call chain. Inside one,
 * the attempt consumes a withheld request's exemption before the request starts; outside one, nothing
 * does unless the caller itself consumes it.
 */
export const withinBootstrapAttempt = (): boolean => attemptGuard.getStore() !== undefined;

const ask = (request: BootstrapWriteRequest): void => {
  const guard = attemptGuard.getStore();
  if (guard === undefined) {
    throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "a Repo Factory GitHub write outside a bootstrap attempt is refused", {
      request: { ...request },
    });
  }
  guard.beforeRequest(request);
};

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** A client that asks the attempt's guard immediately before each mutating request it sends. */
export const guardGitHubWrites = (client: GitHubClient): GitHubClient => ({
  request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (MUTATING.has(method)) ask({ kind: "api", method, target: path });
    return client.request<T>(method, path, body);
  },
});

/** A git runner that asks the attempt's guard immediately before a push, the one git command that writes to GitHub. */
export const guardGitWrites = (run: GitRunner): GitRunner => (cwd, args) => {
  if (args.includes("push")) ask({ kind: "git", method: "push", target: cwd });
  return run(cwd, args);
};

/** The bootstrap's production GitHub port: the API port over a guarded client and git runner. */
export const createBootstrapGitHubWritePort = (
  client: GitHubClient = new GhCliGitHubClient(),
  runGit: GitRunner = (cwd, args) => git(cwd, args, { allowFailure: true }),
): GitHubWritePort => createGitHubApiWritePort({ client: guardGitHubWrites(client), git: guardGitWrites(runGit) });
