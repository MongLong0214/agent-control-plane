import { describe, expect, it } from "vitest";

import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  GhCliGitHubClient,
  createGitHubApiWritePort,
  parseGitHubIdentity,
} from "../../src/bootstrap/github-write-port.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";

/**
 * Issue #246 — the production GitHub write port, exercised without a network. The client and
 * the git runner are both injected, so these tests read the exact requests and argv the port
 * would send. Nothing here reaches GitHub; the producer-level behaviour (ordering, receipts,
 * resume, refusals) is in `repo-factory-github-producer.test.ts` against a double of this port.
 */

type Call = { method: string; path: string; body?: unknown };

const scriptedClient = (answers: Record<string, unknown>): GitHubClient & { calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
      calls.push(body === undefined ? { method, path } : { method, path, body });
      const key = `${method} ${path}`;
      if (!(key in answers)) throw acpError(ReasonCode.NOT_FOUND, "Not Found", { status: 404 });
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
};

const target = { owner: "acme", name: "fixture" };

describe("GitHub write port over the REST API (#246)", () => {
  it("parses only github: identities with an owner and a name", () => {
    expect(parseGitHubIdentity("github:acme/fixture")).toEqual({ owner: "acme", name: "fixture", ref: null });
    expect(parseGitHubIdentity("github:acme/fixture#main")).toEqual({ owner: "acme", name: "fixture", ref: "main" });
    expect(parseGitHubIdentity("local:primary")).toBeNull();
    expect(parseGitHubIdentity("github:acme")).toBeNull();
    expect(parseGitHubIdentity("github:acme/../x")).toBeNull();
    expect(parseGitHubIdentity("github:acme/fixture#a..b")).toBeNull();
  });

  it("observes a repository as GitHub reports it, and reads a 404 as absent but no other failure", async () => {
    const client = scriptedClient({
      "GET repos/acme/fixture": {
        node_id: "R_kgDOreal",
        full_name: "Acme/fixture",
        visibility: "public",
        private: false,
        default_branch: "main",
        stargazers_count: 7,
      },
    });
    const port = createGitHubApiWritePort({ client });
    expect(await port.observeRepository(target)).toEqual({
      nodeId: "R_kgDOreal",
      fullName: "Acme/fixture",
      visibility: "public",
      defaultBranch: "main",
    });
    expect(await port.observeRepository({ owner: "acme", name: "absent" })).toBeNull();

    const failing = createGitHubApiWritePort({
      client: scriptedClient({
        "GET repos/acme/fixture": acpError(ReasonCode.INTERNAL_ERROR, "Bad Gateway", { status: 502 }),
      }),
    });
    await expect(failing.observeRepository(target)).rejects.toMatchObject({ evidence: { status: 502 } });
  });

  it("creates under an organization through the organization endpoint and returns GitHub's answer", async () => {
    const client = scriptedClient({
      "GET users/acme": { login: "acme", type: "Organization" },
      "POST orgs/acme/repos": {
        node_id: "R_kgDOnew",
        full_name: "acme/fixture",
        visibility: "public",
        private: false,
        default_branch: null,
      },
    });
    const port = createGitHubApiWritePort({ client });
    const created = await port.createRepository(target, "public");
    expect(created).toEqual({ nodeId: "R_kgDOnew", fullName: "acme/fixture", visibility: "public", defaultBranch: null });
    expect(client.calls.at(-1)).toEqual({
      method: "POST",
      path: "orgs/acme/repos",
      body: { name: "fixture", private: false, visibility: "public", auto_init: false },
    });
  });

  it("creates under the authenticated user only when the owner is that user", async () => {
    const client = scriptedClient({
      "GET users/acme": { login: "acme", type: "User" },
      "GET user": { login: "acme" },
      "POST user/repos": { node_id: "R_kgDOmine", full_name: "acme/fixture", visibility: "private", private: true },
    });
    const port = createGitHubApiWritePort({ client });
    await port.createRepository(target, "private");
    expect(client.calls.at(-1)).toEqual({
      method: "POST",
      path: "user/repos",
      body: { name: "fixture", private: true, visibility: "private", auto_init: false },
    });
  });

  it("refuses to create under another user's account rather than landing under the authenticated one", async () => {
    const client = scriptedClient({
      "GET users/acme": { login: "acme", type: "User" },
      "GET user": { login: "octocat" },
    });
    const port = createGitHubApiWritePort({ client });
    await expect(port.createRepository(target, "public")).rejects.toThrow(/octocat/);
    expect(client.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("reads a branch head, sets the default branch, and protects and re-reads a branch in the port's own vocabulary", async () => {
    const client = scriptedClient({
      "GET repos/acme/fixture/branches/main": { name: "main", commit: { sha: "a".repeat(40) } },
      "PATCH repos/acme/fixture": {},
      "PUT repos/acme/fixture/branches/main/protection": {},
      "GET repos/acme/fixture/branches/main/protection": {
        required_status_checks: { strict: true, contexts: ["z-check", "project-ci"] },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      },
    });
    const port = createGitHubApiWritePort({ client });
    expect(await port.observeBranch(target, "main")).toEqual({ name: "main", headSha: "a".repeat(40) });
    expect(await port.observeBranch(target, "absent")).toBeNull();

    await port.setDefaultBranch(target, "main");
    expect(client.calls.at(-1)).toEqual({ method: "PATCH", path: "repos/acme/fixture", body: { default_branch: "main" } });

    await port.protectBranch(target, "main", {
      requiredStatusChecks: ["project-ci"],
      enforceAdmins: true,
      requiredApprovingReviewCount: 1,
      allowForcePushes: false,
      allowDeletions: false,
    });
    expect(client.calls.at(-1)).toEqual({
      method: "PUT",
      path: "repos/acme/fixture/branches/main/protection",
      body: {
        required_status_checks: { strict: true, contexts: ["project-ci"] },
        enforce_admins: true,
        required_pull_request_reviews: { required_approving_review_count: 1 },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      },
    });

    expect(await port.observeBranchProtection(target, "main")).toEqual({
      requiredStatusChecks: ["project-ci", "z-check"],
      enforceAdmins: true,
      requiredApprovingReviewCount: null,
      allowForcePushes: false,
      allowDeletions: false,
    });
    expect(await port.observeBranchProtection(target, "unprotected")).toBeNull();
  });

  it("pushes and fetches through git with gh as the only credential helper, so the push authenticates as the API caller", async () => {
    const seen: Array<{ cwd: string; args: readonly string[] }> = [];
    const port = createGitHubApiWritePort({
      client: scriptedClient({}),
      git: async (cwd, args) => {
        seen.push({ cwd, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await port.pushBranch(target, "main", "/checkout", "b".repeat(40));
    await port.fetchBranch(target, "main", "/checkout");
    const helper = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
    expect(seen).toEqual([
      {
        cwd: "/checkout",
        args: [...helper, "push", "https://github.com/acme/fixture.git", `${"b".repeat(40)}:refs/heads/main`],
      },
      { cwd: "/checkout", args: [...helper, "fetch", "https://github.com/acme/fixture.git", "refs/heads/main"] },
    ]);

    const refusing = createGitHubApiWritePort({
      client: scriptedClient({}),
      git: async () => ({ stdout: "", stderr: "remote: Permission denied", exitCode: 128 }),
    });
    await expect(refusing.pushBranch(target, "main", "/checkout", "b".repeat(40))).rejects.toThrow(/Permission denied/);
  });
});

describe("gh CLI transport (#246)", () => {
  it("sends `gh api` with the method, the path, and a body only on stdin", async () => {
    const seen: Array<{ args: readonly string[]; stdin: string | null }> = [];
    const client = new GhCliGitHubClient(async (args, stdin) => {
      seen.push({ args, stdin });
      return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
    });
    expect(await client.request("GET", "repos/acme/fixture")).toEqual({ ok: true });
    await client.request("POST", "orgs/acme/repos", { name: "fixture" });
    expect(seen).toEqual([
      { args: ["api", "--method", "GET", "repos/acme/fixture"], stdin: null },
      { args: ["api", "--method", "POST", "orgs/acme/repos", "--input", "-"], stdin: '{"name":"fixture"}' },
    ]);
  });

  it("carries GitHub's HTTP status on a failure, so a 404 can be told from every other refusal", async () => {
    const client = new GhCliGitHubClient(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
    }));
    await expect(client.request("GET", "repos/acme/absent")).rejects.toMatchObject({
      reasonCode: ReasonCode.NOT_FOUND,
      evidence: { status: 404 },
    });

    const unheard = new GhCliGitHubClient(async () => ({ exitCode: 1, stdout: "", stderr: "dial tcp: timeout" }));
    await expect(unheard.request("GET", "repos/acme/fixture")).rejects.toMatchObject({
      reasonCode: ReasonCode.INTERNAL_ERROR,
      evidence: { status: null },
    });
  });
});
