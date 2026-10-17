import { execFileSync } from "node:child_process";

import type { GitHubClient } from "../../src/github/github-kernel.ts";

/**
 * #512 (v45) — a GitHub API double that answers the object-addressed endpoints the exact-commit reader
 * uses from a real git repository (the "remote"), the way GitHub does: `git/commits/{sha}` answers
 * only for a commit object and is a non-200 (a throw) for any other object or an absent one,
 * `git/trees/{sha}` lists one tree, `git/blobs/{sha}` returns base64 content, `git/ref/heads/{b}`
 * names a branch head, and `compare/{base}...{head}` reports ahead/identical/behind/diverged. Every
 * request is recorded, so a witness can assert that only GET was sent and which objects were asked
 * for. `override` lets a witness answer one path with something else (another sha, a body without
 * commit fields) to show the reader refuses it.
 */
export class GitObjectGitHub implements GitHubClient {
  readonly requests: string[] = [];
  readonly overrides = new Map<string, () => unknown>();

  constructor(private readonly remote: string, private readonly slug = "acme/fixture") {}

  private git(args: readonly string[]): string {
    return execFileSync("git", ["-C", this.remote, "--no-replace-objects", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
  }

  private tryGit(args: readonly string[]): string | null {
    try {
      return this.git(args);
    } catch {
      return null;
    }
  }

  private notFound(path: string): never {
    throw Object.assign(new Error(`GitHub 404 for ${path}`), { status: 404 });
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string): Promise<T> {
    this.requests.push(`${method} ${path}`);
    const override = this.overrides.get(path);
    if (override) return override() as T;
    if (method !== "GET") throw new Error(`the exact-commit reader sent ${method} ${path}`);
    const prefix = `/repos/${this.slug}/`;
    if (!path.startsWith(prefix)) this.notFound(path);
    const rest = path.slice(prefix.length);
    let match = /^git\/commits\/([0-9a-fA-F]+)$/.exec(rest);
    if (match) {
      const sha = match[1]!;
      if (this.tryGit(["cat-file", "-t", sha])?.trim() !== "commit") this.notFound(path);
      const tree = this.git(["rev-parse", `${sha}^{tree}`]).trim();
      const parents = this.git(["rev-list", "--parents", "-n", "1", sha]).trim().split(" ").slice(1);
      return { sha, tree: { sha: tree }, parents: parents.map((parent) => ({ sha: parent })) } as T;
    }
    match = /^git\/trees\/([0-9a-f]+)$/.exec(rest);
    if (match) {
      const sha = match[1]!;
      if (this.tryGit(["cat-file", "-t", sha])?.trim() !== "tree") this.notFound(path);
      const tree = this.git(["ls-tree", sha])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, name] = line.split("\t");
          const [mode, type, object] = meta!.split(" ");
          return { path: name, mode, type, sha: object };
        });
      return { sha, tree, truncated: false } as T;
    }
    match = /^git\/blobs\/([0-9a-f]+)$/.exec(rest);
    if (match) {
      const sha = match[1]!;
      if (this.tryGit(["cat-file", "-t", sha])?.trim() !== "blob") this.notFound(path);
      const bytes = execFileSync("git", ["-C", this.remote, "--no-replace-objects", "cat-file", "blob", sha], { timeout: 30_000 });
      return { sha, encoding: "base64", content: bytes.toString("base64") } as T;
    }
    match = /^git\/ref\/heads\/(.+)$/.exec(rest);
    if (match) {
      const head = this.tryGit(["rev-parse", "--verify", `refs/heads/${decodeURIComponent(match[1]!)}`]);
      if (!head) this.notFound(path);
      return { object: { sha: head.trim(), type: "commit" } } as T;
    }
    match = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest);
    if (match) {
      const [base, head] = [match[1]!, match[2]!];
      if (base === head) return { status: "identical" } as T;
      const ahead = this.tryGit(["merge-base", "--is-ancestor", base, head]) !== null;
      const behind = this.tryGit(["merge-base", "--is-ancestor", head, base]) !== null;
      return { status: ahead ? "ahead" : behind ? "behind" : "diverged" } as T;
    }
    this.notFound(path);
  }
}
