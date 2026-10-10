import { describe, expect, it } from "vitest";

import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  GhCliGitHubClient,
  UNOBSERVED,
  createGitHubApiWritePort,
  ghChildEnv,
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
      description: null,
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
    const created = await port.createRepository(target, "public", "repo-factory:marker");
    expect(created).toEqual({
      nodeId: "R_kgDOnew",
      fullName: "acme/fixture",
      visibility: "public",
      description: null,
      defaultBranch: null,
    });
    expect(client.calls.at(-1)).toEqual({
      method: "POST",
      path: "orgs/acme/repos",
      body: { name: "fixture", description: "repo-factory:marker", private: false, visibility: "public", auto_init: false },
    });
  });

  it("creates under the authenticated user only when the owner is that user", async () => {
    const client = scriptedClient({
      "GET users/acme": { login: "acme", type: "User" },
      "GET user": { login: "acme" },
      "POST user/repos": { node_id: "R_kgDOmine", full_name: "acme/fixture", visibility: "private", private: true },
    });
    const port = createGitHubApiWritePort({ client });
    await port.createRepository(target, "private", "repo-factory:marker");
    expect(client.calls.at(-1)).toEqual({
      method: "POST",
      path: "user/repos",
      body: { name: "fixture", description: "repo-factory:marker", private: true, visibility: "private", auto_init: false },
    });
  });

  it("refuses to create under another user's account rather than landing under the authenticated one", async () => {
    const client = scriptedClient({
      "GET users/acme": { login: "acme", type: "User" },
      "GET user": { login: "octocat" },
    });
    const port = createGitHubApiWritePort({ client });
    await expect(port.createRepository(target, "public", "repo-factory:marker")).rejects.toThrow(/octocat/);
    expect(client.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("reads a branch head, sets the default branch, and protects and re-reads a branch in the port's own vocabulary", async () => {
    // RF-S14: the protection is re-read after the write and reported as GitHub holds it, not as it was asked for.
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
      requiredStatusChecks: { strict: true, contexts: ["project-ci"] },
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
      requiredStatusChecks: { strict: true, contexts: ["project-ci", "z-check"] },
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
      { args: ["api", "--hostname", "github.com", "--method", "GET", "repos/acme/fixture"], stdin: null },
      {
        args: ["api", "--hostname", "github.com", "--method", "POST", "orgs/acme/repos", "--input", "-"],
        stdin: '{"name":"fixture"}',
      },
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

/**
 * PR #1043 review witnesses. Each case reproduces a finding against the reviewed head
 * (afd93586) and is kept as its regression guard.
 */
describe("PR #1043 review witnesses — the port reports only what GitHub said, from the host it names", () => {
  it("RF1043-04: protection readback carries `strict` as GitHub returned it, so a non-strict check cannot pass for a strict one", async () => {
    const client = scriptedClient({
      "GET repos/acme/fixture/branches/main/protection": {
        required_status_checks: { strict: false, contexts: ["project-ci"] },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      },
    });
    const observed = await createGitHubApiWritePort({ client }).observeBranchProtection(target, "main");
    expect(observed).toEqual({
      requiredStatusChecks: { strict: false, contexts: ["project-ci"] },
      enforceAdmins: true,
      requiredApprovingReviewCount: null,
      allowForcePushes: false,
      allowDeletions: false,
    });
  });

  it("RF1043-04: a branch answer that names no branch is not filled in with the branch that was asked for", async () => {
    const client = scriptedClient({
      "GET repos/acme/fixture/branches/main": { commit: { sha: "a".repeat(40) } },
    });
    await expect(createGitHubApiWritePort({ client }).observeBranch(target, "main")).rejects.toThrow(/names no branch/);
  });

  it("RF1043-05: every `gh api` call names github.com, the host every github: identity and git URL means", async () => {
    const seen: Array<readonly string[]> = [];
    const client = new GhCliGitHubClient(async (args) => {
      seen.push(args);
      return { exitCode: 0, stdout: "{}", stderr: "" };
    });
    await client.request("GET", "repos/acme/fixture");
    await client.request("POST", "orgs/acme/repos", { name: "fixture" });
    for (const args of seen) expect(args.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
  });
});

describe("gh child environment (#246)", () => {
  it("drops GH_HOST from the environment a `gh` child inherits, and keeps the rest", () => {
    const parent = { HOME: "/home/owner", PATH: "/usr/bin", GH_HOST: "ghe.example.com", GH_CONFIG_DIR: "/cfg" };
    expect(ghChildEnv(parent)).toEqual({ HOME: "/home/owner", PATH: "/usr/bin", GH_CONFIG_DIR: "/cfg" });
    expect(parent.GH_HOST).toBe("ghe.example.com");
  });
});

/**
 * PR #1043 review round 2 witness (RF1043-04). Reproduced against the round-1 head (88b286db),
 * where it fails, and kept as the regression guard.
 */
describe("PR #1043 review round 2 witnesses — the port", () => {
  const protectionAnswer = (reviews: Record<string, unknown>) =>
    scriptedClient({
      "GET repos/acme/fixture/branches/main/protection": {
        required_status_checks: { strict: true, contexts: ["project-ci"] },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        ...reviews,
      },
    });
  const reviewCount = async (reviews: Record<string, unknown>) =>
    (await createGitHubApiWritePort({ client: protectionAnswer(reviews) }).observeBranchProtection(target, "main"))
      ?.requiredApprovingReviewCount;

  it("RF1043-04: a present review requirement with no count is unobserved, not \"no reviews required\"", async () => {
    expect(await reviewCount({ required_pull_request_reviews: {} })).toBe("unobserved");
    expect(UNOBSERVED).toBe("unobserved");
  });

  it("keeps absent, null, zero, empty and countless review answers apart", async () => {
    expect(await reviewCount({})).toBeNull();
    expect(await reviewCount({ required_pull_request_reviews: null })).toBeNull();
    expect(await reviewCount({ required_pull_request_reviews: { required_approving_review_count: 0 } })).toBe(0);
    expect(await reviewCount({ required_pull_request_reviews: { required_approving_review_count: 2 } })).toBe(2);
    expect(await reviewCount({ required_pull_request_reviews: { required_approving_review_count: null } })).toBe(UNOBSERVED);
  });

  it("reads status-check contexts it cannot read in full as unobserved, never as a shorter list", async () => {
    const contexts = async (value: unknown) =>
      (
        await createGitHubApiWritePort({
          client: scriptedClient({
            "GET repos/acme/fixture/branches/main/protection": {
              required_status_checks: { strict: true, contexts: value },
              enforce_admins: { enabled: true },
              allow_force_pushes: { enabled: false },
              allow_deletions: { enabled: false },
            },
          }),
        }).observeBranchProtection(target, "main")
      )?.requiredStatusChecks?.contexts;
    expect(await contexts(["b", "a"])).toEqual(["a", "b"]);
    expect(await contexts(undefined)).toBeNull();
    expect(await contexts(["a", 7])).toBeNull();
  });
});
