import { spawn } from "node:child_process";

import { acpError, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { git, type GitResult } from "../git/git.ts";
import type { GitHubClient } from "../github/github-kernel.ts";

/**
 * Issue #246 — the GitHub surface the repo factory producer performs its planned operations
 * through.
 *
 * WHY a port rather than calls inside the producer. Three reasons, each measured against this
 * repository rather than taken from a pattern:
 *
 *  1. The producer's refusals have to be proven to refuse *before* anything is written. "Writes
 *     0" is only an assertion if something counts the writes, and a port is the one place every
 *     write passes through. A double of it can count; a `gh` subprocess cannot.
 *  2. This packet may not write to GitHub at all. The production implementation below is
 *     therefore exercised only through an injected client and git runner, and the producer's
 *     own behaviour — ordering, receipts, resume, wrong-target — is exercised against a double
 *     backed by real bare repositories. Neither path needs a network.
 *  3. Reads and writes are separate methods on purpose. The producer judges every write by a
 *     separate read afterwards (Integration §16.2: a command that exited 0 is not evidence the
 *     remote is in the asked-for state), and a port whose write returned "the new state" would
 *     let the write certify itself.
 *
 * The port reads and writes; it never decides. Whether a repository is ours, whether a
 * readback matches, and what a receipt says are all the producer's judgement
 * (`repo-factory-github.ts`).
 *
 * Credential: the owner's own `gh` authentication, never the GitHub App installation token
 * `GitHubAppClient` uses. That App can publish the trusted production gate check; a bootstrap
 * that creates repositories has no business holding it (Repo Factory's `github_port.py` draws
 * the same line), and an installation token cannot create a repository under a user account.
 */

export type GitHubVisibility = "public" | "private";

export interface GitHubRepositoryTarget {
  owner: string;
  name: string;
}

/** What GitHub reports for a repository. `visibility` is GitHub's word, not the plan's. */
export interface ObservedRepository {
  nodeId: string;
  fullName: string;
  visibility: string;
  /** Carries the create marker that lets a retry recognise its own create (RF1043-02). */
  description: string | null;
  defaultBranch: string | null;
}

export interface ObservedBranch {
  name: string;
  headSha: string;
}

/**
 * Branch protection in the port's own vocabulary — every fact the producer asks for and reads
 * back. Everything else GitHub's protection document carries is neither requested nor judged,
 * and saying so here is the point: a readback compared on fields nobody set fails on defaults,
 * and one compared on fewer fields than were set passes on a weaker protection — which is what
 * leaving `strict` out did (PR #1043 review, RF1043-04): it was requested and never read back.
 * `requiredStatusChecks: null` is "no required checks", GitHub's own representation of that.
 */
export interface BranchProtectionState {
  requiredStatusChecks: { strict: boolean; contexts: string[] } | null;
  enforceAdmins: boolean;
  requiredApprovingReviewCount: number | null;
  allowForcePushes: boolean;
  allowDeletions: boolean;
}

/**
 * Protection as GitHub answered it. A flag GitHub's answer did not carry is `null` — unknown —
 * never the value it was asked for or a default, so it cannot compare equal to a requested one.
 */
export interface ObservedBranchProtection {
  requiredStatusChecks: { strict: boolean | null; contexts: string[] | null } | null;
  enforceAdmins: boolean | null;
  /**
   * `null` here is an answer — GitHub sent no review requirement, or sent it as null — so it
   * cannot also stand for "GitHub sent a review object without a count". That case is
   * `UNOBSERVED`, which equals no requested value (PR #1043 review round 2, RF1043-04).
   */
  requiredApprovingReviewCount: number | null | typeof UNOBSERVED;
  allowForcePushes: boolean | null;
  allowDeletions: boolean | null;
}

/** A field GitHub's answer carried no value for, where `null` already means something else. */
export const UNOBSERVED = "unobserved";

export interface GitHubWritePort {
  observeRepository(target: GitHubRepositoryTarget): Promise<ObservedRepository | null>;
  /**
   * Returns GitHub's response to the create. The producer still re-reads it separately.
   * `description` carries the producer's create marker, recorded before the call. `autoInit` is the
   * create's initialization option, sent as stated: `true` only for a create-only plan (#246 C5),
   * whose default branch GitHub then initializes; absent, the request states `auto_init: false`.
   */
  createRepository(
    target: GitHubRepositoryTarget,
    visibility: GitHubVisibility,
    description: string,
    autoInit?: boolean,
  ): Promise<ObservedRepository>;
  observeBranch(target: GitHubRepositoryTarget, branch: string): Promise<ObservedBranch | null>;
  pushBranch(target: GitHubRepositoryTarget, branch: string, checkoutPath: string, commitSha: string): Promise<void>;
  /** A read: brings an already-pushed commit into a fresh local checkout on resume. */
  fetchBranch(target: GitHubRepositoryTarget, branch: string, checkoutPath: string): Promise<void>;
  setDefaultBranch(target: GitHubRepositoryTarget, branch: string): Promise<void>;
  observeBranchProtection(target: GitHubRepositoryTarget, branch: string): Promise<ObservedBranchProtection | null>;
  protectBranch(target: GitHubRepositoryTarget, branch: string, desired: BranchProtectionState): Promise<void>;
}

export interface ParsedGitHubIdentity {
  owner: string;
  name: string;
  ref: string | null;
}

/**
 * `github:<owner>/<name>` or `github:<owner>/<name>#<ref>`. The host prefix is required — an
 * `owner/name` alone leaves which forge it names to an agreement outside the string — and it is
 * the same shape `assertPortableManifest` requires of a manifest remote, which is what lets a
 * produced identity match an approved manifest at all.
 */
const GITHUB_IDENTITY = /^github:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)(?:#([A-Za-z0-9._/-]+))?$/;

export const parseGitHubIdentity = (identity: string): ParsedGitHubIdentity | null => {
  const match = GITHUB_IDENTITY.exec(identity);
  if (match === null) return null;
  const owner = match[1];
  const name = match[2];
  if (owner === undefined) return null;
  if (name === undefined) return null;
  if (name === ".") return null;
  if (name === "..") return null;
  const ref = match[3] ?? null;
  if (ref !== null) {
    if (ref.includes("..")) return null;
    if (ref.startsWith("/")) return null;
    if (ref.endsWith("/")) return null;
  }
  return { owner, name, ref };
};

/** GitHub names are case-insensitive; a receipt still records GitHub's own spelling. */
export const sameGitHubName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const statusOf = (error: unknown): number | null => {
  if (!isAcpError(error)) return null;
  const status = (error.evidence as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

/** A 404 is "absent". Every other failure — including an unreadable one — propagates. */
const absentOn404 = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
};

interface RepositoryDocument {
  node_id?: unknown;
  full_name?: unknown;
  visibility?: unknown;
  private?: unknown;
  description?: unknown;
  default_branch?: unknown;
}

/**
 * #246 C5, review C5I-R1-03 — a provider identity this port reports: non-empty printable ASCII with no
 * whitespace, as every GitHub node id is. An empty or malformed one is no identity at all, so it can
 * neither attribute a repository nor be recorded as the one a create was answered with.
 */
export const isGitHubNodeId = (value: unknown): value is string =>
  typeof value === "string" ? /^[\x21-\x7e]{1,256}$/.test(value) : false;

/** A full commit id: 40 hex digits (SHA-1) or 64 (SHA-256). */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const repositoryFrom = (document: RepositoryDocument, path: string): ObservedRepository => {
  const nodeId = document.node_id;
  const fullName = document.full_name;
  // Review C5I-R1-03 — checked here, before any caller can record or accept the answer: an answer
  // with no valid identity throws, and the caller keeps the request it answered in doubt.
  if (!isGitHubNodeId(nodeId)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "GitHub's repository answer carries no valid node id", { path });
  }
  if (typeof fullName !== "string") {
    throw acpError(ReasonCode.INTERNAL_ERROR, "GitHub's repository answer carries no full name", { path });
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "GitHub's repository answer carries no owner/name full name", { path });
  }
  // `visibility` is the field; `private` is the older one GitHub still sends. Neither is
  // invented when both are missing — an unknown visibility cannot match an approved one.
  const visibility =
    typeof document.visibility === "string"
      ? document.visibility
      : typeof document.private === "boolean"
        ? document.private ? "private" : "public"
        : "unknown";
  const defaultBranch = typeof document.default_branch === "string" ? document.default_branch : null;
  const description = typeof document.description === "string" ? document.description : null;
  return { nodeId, fullName, visibility, description, defaultBranch };
};

interface ProtectionDocument {
  required_status_checks?: { strict?: unknown; contexts?: unknown } | null;
  enforce_admins?: { enabled?: unknown } | null;
  required_pull_request_reviews?: { required_approving_review_count?: unknown } | null;
  allow_force_pushes?: { enabled?: unknown } | null;
  allow_deletions?: { enabled?: unknown } | null;
}

/** A flag GitHub did not report is unknown (`null`), never "off". */
const enabled = (flag: { enabled?: unknown } | null | undefined): boolean | null =>
  typeof flag?.enabled === "boolean" ? flag.enabled : null;

/** Every context, as strings, or unobserved — never a filtered subset that reads as the whole. */
const contextsFrom = (contexts: unknown): string[] | null => {
  if (!Array.isArray(contexts)) return null;
  const strings = contexts.filter((context): context is string => typeof context === "string");
  return strings.length === contexts.length ? strings.sort() : null;
};

/**
 * Four answers kept apart, because collapsing any two certifies a fact GitHub did not state:
 * a requirement object that is absent or null means the requirement is off; one that is present
 * says what it holds; a present one without the field asked about is unobserved. GitHub omits
 * `required_status_checks` and `required_pull_request_reviews` when they are off, so their
 * absence is an answer; a missing field inside them, or a missing always-present flag, is not.
 */
const protectionFrom = (document: ProtectionDocument): ObservedBranchProtection => {
  const checks = document.required_status_checks;
  const reviews = document.required_pull_request_reviews;
  const reviewCount = reviews == null ? null : reviews.required_approving_review_count;
  return {
    requiredStatusChecks:
      checks == null
        ? null
        : {
            strict: typeof checks.strict === "boolean" ? checks.strict : null,
            contexts: contextsFrom(checks.contexts),
          },
    enforceAdmins: enabled(document.enforce_admins),
    requiredApprovingReviewCount:
      reviews == null ? null : typeof reviewCount === "number" ? reviewCount : UNOBSERVED,
    allowForcePushes: enabled(document.allow_force_pushes),
    allowDeletions: enabled(document.allow_deletions),
  };
};

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

export interface GitHubApiWritePortOptions {
  client: GitHubClient;
  /** Defaults to this repository's bounded, argv-only `git()`. */
  git?: GitRunner;
}

/**
 * Pushes and fetches authenticate through `gh` and nothing else. The empty `credential.helper=`
 * clears every helper configured above this invocation first; without it a keychain helper
 * holding a different account answers first, and the API would create the repository as one
 * account while git pushed to it as another.
 */
const GH_CREDENTIAL = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] as const;

const remoteUrl = (target: GitHubRepositoryTarget): string =>
  `https://${GITHUB_HOST}/${target.owner}/${target.name}.git`;

const repoPath = (target: GitHubRepositoryTarget): string => `repos/${target.owner}/${target.name}`;

export const createGitHubApiWritePort = (options: GitHubApiWritePortOptions): GitHubWritePort => {
  const { client } = options;
  const runGit: GitRunner = options.git ?? ((cwd, args) => git(cwd, args, { allowFailure: true }));
  const gitOrThrow = async (cwd: string, args: readonly string[], what: string): Promise<void> => {
    const result = await runGit(cwd, args);
    if (result.exitCode !== 0) {
      throw acpError(ReasonCode.INTERNAL_ERROR, `${what} failed: ${result.stderr.trim().slice(0, 300)}`, {
        exitCode: result.exitCode,
      });
    }
  };
  const branchPath = (target: GitHubRepositoryTarget, branch: string): string =>
    `${repoPath(target)}/branches/${encodeURIComponent(branch)}`;

  return {
    observeRepository: (target) =>
      absentOn404(async () =>
        repositoryFrom(await client.request<RepositoryDocument>("GET", repoPath(target)), repoPath(target)),
      ),

    async createRepository(target, visibility, description, autoInit = false) {
      // The endpoint decides the owner, so it is chosen from what GitHub says the owner is —
      // never assumed. `POST user/repos` creates under whoever is authenticated, whatever the
      // plan named; that is the user/organization confusion this refuses rather than risks.
      const owner = await client.request<{ type?: unknown }>("GET", `users/${target.owner}`);
      let path: string;
      if (owner.type === "Organization") {
        path = `orgs/${target.owner}/repos`;
      } else {
        const me = await client.request<{ login?: unknown }>("GET", "user");
        const login = typeof me.login === "string" ? me.login : null;
        if (login === null ? true : !sameGitHubName(login, target.owner)) {
          throw acpError(
            ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
            `refusing to create ${target.owner}/${target.name}: the owner is a user account and the authenticated account is ${login ?? "unknown"}`,
            { owner: target.owner, authenticated: login },
          );
        }
        path = "user/repos";
      }
      const created = await client.request<RepositoryDocument>("POST", path, {
        name: target.name,
        description,
        private: visibility === "private",
        visibility,
        auto_init: autoInit,
      });
      return repositoryFrom(created, path);
    },

    observeBranch: (target, branch) =>
      absentOn404(async () => {
        const document = await client.request<{ name?: unknown; commit?: { sha?: unknown } | null }>(
          "GET",
          branchPath(target, branch),
        );
        const sha = document.commit?.sha;
        if (typeof sha !== "string") {
          throw acpError(ReasonCode.INTERNAL_ERROR, "GitHub's branch answer carries no head", {
            path: branchPath(target, branch),
          });
        }
        // Review C5I-R1-03 — the head is an identity the producer records and compares; an empty or
        // partial one is no head.
        if (!COMMIT_ID.test(sha)) {
          throw acpError(ReasonCode.INTERNAL_ERROR, "GitHub's branch answer carries no full commit id", {
            path: branchPath(target, branch),
          });
        }
        // Not filled in from the request (RF1043-04): an answer that does not say which branch it
        // describes is not a readback of the branch that was asked about.
        if (typeof document.name !== "string") {
          throw acpError(ReasonCode.INTERNAL_ERROR, "GitHub's branch answer names no branch", {
            path: branchPath(target, branch),
          });
        }
        return { name: document.name, headSha: sha };
      }),

    async pushBranch(target, branch, checkoutPath, commitSha) {
      await gitOrThrow(
        checkoutPath,
        [...GH_CREDENTIAL, "push", remoteUrl(target), `${commitSha}:refs/heads/${branch}`],
        `git push to ${target.owner}/${target.name}`,
      );
    },

    async fetchBranch(target, branch, checkoutPath) {
      await gitOrThrow(
        checkoutPath,
        [...GH_CREDENTIAL, "fetch", remoteUrl(target), `refs/heads/${branch}`],
        `git fetch from ${target.owner}/${target.name}`,
      );
    },

    async setDefaultBranch(target, branch) {
      await client.request("PATCH", repoPath(target), { default_branch: branch });
    },

    observeBranchProtection: (target, branch) =>
      absentOn404(async () =>
        protectionFrom(await client.request<ProtectionDocument>("GET", `${branchPath(target, branch)}/protection`)),
      ),

    async protectBranch(target, branch, desired) {
      await client.request("PUT", `${branchPath(target, branch)}/protection`, {
        required_status_checks:
          desired.requiredStatusChecks === null
            ? null
            : { strict: desired.requiredStatusChecks.strict, contexts: [...desired.requiredStatusChecks.contexts] },
        enforce_admins: desired.enforceAdmins,
        required_pull_request_reviews:
          desired.requiredApprovingReviewCount === null
            ? null
            : { required_approving_review_count: desired.requiredApprovingReviewCount },
        restrictions: null,
        allow_force_pushes: desired.allowForcePushes,
        allow_deletions: desired.allowDeletions,
      });
    },
  };
};

export interface GhRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: readonly string[], stdin: string | null) => Promise<GhRunResult>;

const GH_TIMEOUT_MS = 120_000;

/**
 * The only host this port addresses. A `github:` identity means github.com, and so does every git
 * URL `remoteUrl` builds; the REST half has to mean the same host, or a `GH_HOST` in the
 * environment sends observations, the create and the node-id checks to one server while the
 * push lands on a same-named repository on another (PR #1043 review, RF1043-05).
 */
export const GITHUB_HOST = "github.com";

/**
 * The environment a `gh` child gets: the parent's, without `GH_HOST`. `--hostname` already
 * names the host on every call; dropping the variable as well means no `gh` behaviour that
 * consults it — a pager, an alias, a future subcommand — can route this port elsewhere.
 */
export const ghChildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const child: NodeJS.ProcessEnv = { ...env };
  delete child["GH_HOST"];
  return child;
};
const GH_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * `gh` as a child: argv only, no shell, a time bound, and the body on stdin rather than argv so
 * nothing in it is ever parsed as a flag. The environment is inherited — less `GH_HOST`, see
 * `ghChildEnv` — because `gh` reads its own authentication from it; nothing here reads, logs or
 * forwards a credential.
 */
const spawnGh: GhRunner = (args, stdin) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("gh", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
      env: ghChildEnv(process.env),
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > GH_MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (overflow) {
        reject(acpError(ReasonCode.INTERNAL_ERROR, "gh produced more output than this client reads", { args }));
        return;
      }
      if (code === null) {
        // Killed — by the time bound or anything else — is not GitHub answering.
        reject(acpError(ReasonCode.INTERNAL_ERROR, `gh ${args.join(" ")} did not answer`, { signal }));
        return;
      }
      resolvePromise({ exitCode: code, stdout, stderr });
    });
    child.stdin.end(stdin ?? "");
  });

/** `gh: Not Found (HTTP 404)` — the status `gh api` prints on a refused request. */
const HTTP_STATUS = /\(HTTP (\d{3})\)/;

/**
 * `GitHubClient` over `gh api`. A failure carries GitHub's HTTP status in its evidence when
 * one arrived (`status: null` when none did), the same distinction `transportOutcome` in the
 * GitHub kernel reads: a 404 is an answer, a dropped connection is not, and `absentOn404` above
 * must never read the second as the first.
 */
export class GhCliGitHubClient implements GitHubClient {
  constructor(private readonly run: GhRunner = spawnGh) {}

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const args = ["api", "--hostname", GITHUB_HOST, "--method", method, path];
    let stdin: string | null = null;
    if (body !== undefined) {
      args.push("--input", "-");
      stdin = JSON.stringify(body);
    }
    const result = await this.run(args, stdin);
    if (result.exitCode !== 0) {
      const match = HTTP_STATUS.exec(result.stderr);
      const status = match?.[1] === undefined ? null : Number(match[1]);
      throw acpError(
        status === 404 ? ReasonCode.NOT_FOUND : ReasonCode.INTERNAL_ERROR,
        `gh api ${method} ${path} failed: ${result.stderr.trim().slice(0, 300)}`,
        { status, method, path },
      );
    }
    const text = result.stdout.trim();
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** The production port: the owner's `gh` authentication, REST for API calls, git for content. */
export const createGhCliGitHubWritePort = (): GitHubWritePort =>
  createGitHubApiWritePort({ client: new GhCliGitHubClient() });
