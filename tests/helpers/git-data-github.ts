import { execFileSync } from "node:child_process";

import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { GitHubClient, GitHubRequestOptions } from "../../src/github/github-kernel.ts";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GitDataCall {
  method: Method;
  path: string;
  body?: unknown;
}

/**
 * What a witness may do to one request: answer it with something else, throw an answered status or
 * silence, or let it apply and then lose the answer. Returning undefined lets the request proceed.
 */
export type GitDataIntercept = (call: GitDataCall) =>
  | { answer: unknown }
  | { status: number }
  | { silence: true }
  | { applyThenSilence: true }
  | undefined;

/**
 * #512 S-PUSH — an in-process GitHub Git Data API double backed by a real bare repository (the "remote"),
 * so every object id it answers is git's own. It never touches the network.
 *
 * It answers the way GitHub does for the endpoints a branch publication uses: `POST git/blobs` (base64
 * content), `POST git/trees` (full entry lists, each referenced object required to exist, 422 otherwise),
 * `POST git/commits` (rendered here from the request fields by its own code, the ISO date's offset kept),
 * `POST git/refs` (create-only: an existing ref is 422 "Reference already exists"), `GET git/ref/heads/<b>`
 * (404 when absent) and `GET branches`. An answered failure carries `status`, as the App transport's
 * refusal does; silence carries none. It runs the kernel's `beforeDispatch` before every request, as the
 * transport does, and a refusal sends nothing. Every request that reached it is recorded.
 */
export class GitDataGitHub implements GitHubClient {
  readonly calls: GitDataCall[] = [];
  readonly intercepts: GitDataIntercept[] = [];
  /** Requests a beforeDispatch refused; they never reached the double. */
  readonly refusedAtDispatch: GitDataCall[] = [];

  constructor(readonly remote: string, private readonly slug = "acme/fixture") {}

  private git(args: readonly string[], input?: Buffer | string): string {
    return execFileSync("git", ["-C", this.remote, ...args], {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
  }

  private tryGit(args: readonly string[]): string | null {
    try {
      return this.git(args).trim();
    } catch {
      return null;
    }
  }

  private answered(status: number, message: string): never {
    throw acpError(ReasonCode.PROBE_FAILED, `GitHub App API request failed: ${message}`, { status });
  }

  private exists(sha: unknown, type?: string): boolean {
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return false;
    const actual = this.tryGit(["cat-file", "-t", sha]);
    return actual !== null && (type === undefined || actual === type);
  }

  /** The ref a branch names on the remote, or null. */
  head(branch: string): string | null {
    return this.tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  }

  /** Points a remote branch at a commit the remote holds, the way another writer would. */
  setHead(branch: string, sha: string): void {
    this.git(["update-ref", `refs/heads/${branch}`, sha]);
  }

  /** POSTs that reached the double, by Git Data endpoint. */
  posts(endpoint: "blobs" | "trees" | "commits" | "refs"): GitDataCall[] {
    return this.calls.filter((call) => call.method === "POST" && call.path.endsWith(`/git/${endpoint}`));
  }

  /** Every object upload (blob, tree or commit) that reached the double. */
  objectUploads(): GitDataCall[] {
    return this.calls.filter((call) => call.method === "POST" && /\/git\/(?:blobs|trees|commits)$/.test(call.path));
  }

  async request<T>(method: Method, path: string, body?: unknown, options?: GitHubRequestOptions): Promise<T> {
    const call: GitDataCall = { method, path, ...(body === undefined ? {} : { body }) };
    if (options?.beforeDispatch) {
      const verified = options.beforeDispatch();
      if (!verified.allowed) {
        this.refusedAtDispatch.push(call);
        throw acpError(verified.reasonCode, verified.message, verified.evidence);
      }
    }
    this.calls.push(call);
    for (const intercept of this.intercepts) {
      const action = intercept(call);
      if (action === undefined) continue;
      if ("answer" in action) return action.answer as T;
      if ("status" in action) this.answered(action.status, `intercepted ${method} ${path}`);
      if ("silence" in action) throw new Error(`no answer for ${method} ${path}`);
      this.apply(method, path, body);
      throw new Error(`answer lost for ${method} ${path}`);
    }
    return this.apply(method, path, body) as T;
  }

  private apply(method: Method, path: string, body: unknown): unknown {
    const prefix = `/repos/${this.slug}/`;
    if (!path.startsWith(prefix)) this.answered(404, "Not Found");
    const rest = path.slice(prefix.length);
    if (method === "GET") {
      const ref = /^git\/ref\/heads\/(.+)$/.exec(rest);
      if (ref) {
        const branch = ref[1]!.split("/").map((part) => decodeURIComponent(part)).join("/");
        const sha = this.head(branch);
        if (sha === null) this.answered(404, "Not Found");
        return { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } };
      }
      if (/^branches\?/.test(rest)) {
        const page = Number(new URL(rest, "https://github.test/").searchParams.get("page") ?? "1");
        if (page > 1) return [];
        const names = this.git(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]).split("\n").filter(Boolean);
        return names.map((name) => ({ name }));
      }
      this.answered(404, "Not Found");
    }
    if (method !== "POST") this.answered(404, "Not Found");
    const input = body as Record<string, unknown>;
    if (rest === "git/blobs") {
      if (input.encoding !== "base64" || typeof input.content !== "string") this.answered(422, "Invalid blob");
      const sha = this.git(["hash-object", "-w", "--stdin"], Buffer.from(input.content as string, "base64")).trim();
      return { sha, url: `https://api.github.test/repos/${this.slug}/git/blobs/${sha}` };
    }
    if (rest === "git/trees") {
      const entries = input.tree as Array<{ path: string; mode: string; type: string; sha: string }>;
      if (!Array.isArray(entries)) this.answered(422, "Invalid tree");
      for (const entry of entries) {
        if (entry.path.includes("/") || entry.path.length === 0) this.answered(422, "Invalid tree path");
        if (entry.type !== "commit" && !this.exists(entry.sha, entry.type)) this.answered(422, "Invalid tree info");
      }
      const listing = entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`).join("\n");
      const sha = this.git(["mktree"], `${listing}${listing ? "\n" : ""}`).trim();
      return { sha, tree: entries, truncated: false };
    }
    if (rest === "git/commits") {
      const fields = input as {
        message: string;
        tree: string;
        parents: string[];
        author: { name: string; email: string; date: string };
        committer: { name: string; email: string; date: string };
      };
      if (!this.exists(fields.tree, "tree")) this.answered(422, "Tree SHA does not exist");
      for (const parent of fields.parents) if (!this.exists(parent, "commit")) this.answered(422, "Parent SHA does not exist");
      // GitHub's rendering, written here independently of the kernel: epoch from the instant, offset as sent.
      const ident = (who: { name: string; email: string; date: string }): string => {
        const offset = /([+-])(\d{2}):(\d{2})$/.exec(who.date);
        const tz = offset ? `${offset[1]}${offset[2]}${offset[3]}` : "+0000";
        return `${who.name} <${who.email}> ${Math.floor(Date.parse(who.date) / 1000)} ${tz}`;
      };
      const object = `tree ${fields.tree}\n${fields.parents.map((parent) => `parent ${parent}\n`).join("")}` +
        `author ${ident(fields.author)}\ncommitter ${ident(fields.committer)}\n\n${fields.message}`;
      const sha = this.git(["hash-object", "-t", "commit", "-w", "--stdin"], Buffer.from(object, "utf8")).trim();
      return { sha, tree: { sha: fields.tree }, parents: fields.parents.map((parent) => ({ sha: parent })), message: fields.message };
    }
    if (rest === "git/refs") {
      const ref = input.ref as string;
      if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) this.answered(422, "Invalid ref");
      if (this.tryGit(["rev-parse", "--verify", "--quiet", ref]) !== null) this.answered(422, "Reference already exists");
      if (!this.exists(input.sha, "commit")) this.answered(422, "Object does not exist");
      this.git(["update-ref", ref, input.sha as string, ""]);
      return { ref, object: { sha: input.sha, type: "commit" } };
    }
    this.answered(404, "Not Found");
  }
}

/**
 * A bare remote holding exactly `baseBranch` at `baseHead` and its history: a local single-branch clone of
 * the checkout, with no network and no other branch.
 */
export const bareRemoteAt = (remote: string, checkout: string, baseBranch: string, baseHead: string): string => {
  execFileSync("git", ["clone", "--quiet", "--bare", "--no-tags", "--single-branch", "--branch", baseBranch, checkout, remote], {
    stdio: "ignore",
    timeout: 30_000,
  });
  execFileSync("git", ["-C", remote, "update-ref", `refs/heads/${baseBranch}`, baseHead], { stdio: "ignore", timeout: 30_000 });
  return remote;
};
