import { describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { GitHubKernel, type GitHubClient, type MergeInput } from "../../src/github/github-kernel.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SESSION_URL = "https://claude.ai/code/session_0000000000000000000000";
const RECORD = "Limit: preserve this record\nRecord-Id: r-111111111111";

/** Exercise the real mergeExecute through its PUT, starting with authorization already satisfied.
 * The transport stops at that boundary: these tests make no claim about post-merge proof or auth.
 */
const fixture = (
  messages: string[],
  title = "A reviewed change",
  total: unknown = messages.length,
) => {
  const input: MergeInput = {
    runId: "test-run",
    repositoryIdentity: "github:example/project",
    pullNumber: 100,
    exactHeadSha: HEAD,
    expectedBaseSha: BASE,
    mergeStrategy: "squash",
    ownerSessionId: "test-owner",
    ownerBindingGeneration: 1,
  };
  const pull = { number: 100, title, commits: total, head: { sha: HEAD, ref: "feature" }, base: { sha: BASE, ref: "main" } };
  const commits = messages.map((message, index) => ({
    sha: index === messages.length - 1 ? HEAD : String(index).padStart(40, "0"),
    commit: { message },
  }));
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const putReached = new Error("PUT captured");
  const client: GitHubClient = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (method === "PUT" && path === "/repos/example/project/pulls/100/merge") throw putReached;
      if (method === "GET" && path === "/repos/example/project/pulls/100") return structuredClone(pull) as T;
      if (method === "GET" && path.startsWith("/repos/example/project/pulls/100/commits?")) {
        const url = new URL(path, "https://github.test");
        const page = Number(url.searchParams.get("page"));
        expect(url.searchParams.get("per_page")).toBe("100");
        // GitHub caps this endpoint at 250, independently of the PR's exact total.
        return commits.slice(0, 250).slice((page - 1) * 100, page * 100) as T;
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    },
  };
  const reserve = vi.fn(() => allow(ReasonCode.OK, undefined));
  const kernel = Object.create(GitHubKernel.prototype) as GitHubKernel;
  Object.assign(kernel, {
    assertAuthority: () => allow(ReasonCode.OK, undefined),
    mergeRepositoryId: () => allow(ReasonCode.OK, "test-repository"),
    receipt: () => undefined,
    assertFreshDaemonFinalization: () => allow(ReasonCode.OK, undefined),
    mergeEvaluate: async () => allow(ReasonCode.OK, undefined),
    preparedPrIntent: () => allow(ReasonCode.OK, { head: "feature", base: "main" }),
    api: () => client,
    writeTarget: () => allow(ReasonCode.OK, {}),
    reserveReceipt: reserve,
    mediate: async (...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(),
  });
  const execute = () => kernel.mergeExecute(input);
  const puts = () => calls.filter((call) => call.method === "PUT");
  const putBody = async () => {
    await expect(execute()).rejects.toBe(putReached);
    expect(puts()).toHaveLength(1);
    return puts()[0]!.body as { sha: string; merge_method: string; commit_title?: string; commit_message?: string };
  };
  return { execute, putBody, puts, commits, pull, calls, reserve, input };
};

describe("the squash PUT publishes a sanitized title and a complete body", () => {
  it.each(["single commit subject", "pull request title"])(
    "sanitizes the actual PUT title and body from the %s",
    async (source) => {
      const dirtyTitle = `fix: preserve the change ${SESSION_URL}`;
      const first = `${source === "single commit subject" ? dirtyTitle : "First change"}\n\n${RECORD}\nX-Claude-Session: ${SESSION_URL}`;
      const messages = source === "single commit subject" ? [first] : [first, `Second change\n\nClaude-Session: ${SESSION_URL}`];
      const body = await fixture(messages, source === "pull request title" ? dirtyTitle : "Other title").putBody();
      expect(body.commit_title).toBe("fix: preserve the change [session reference removed] (#100)");
      expect(body.commit_message).toContain(RECORD);
      expect(body.sha).toBe(HEAD);
      expect(body.merge_method).toBe("squash");
      for (const field of [body.commit_title, body.commit_message]) {
        expect(field).not.toContain(SESSION_URL);
        expect(field).not.toContain("Claude-Session");
      }
    },
  );

  it("refuses a capped 250-commit list for a 251-commit pull before PUT", async () => {
    const test = fixture(Array.from({ length: 251 }, (_, index) => `Change ${index}\n\nLimit: record ${index}`));
    await expect(test.execute()).rejects.toThrow(/250/);
    expect(test.puts()).toHaveLength(0);
    expect(test.calls.filter((call) => /\/commits\?/.test(call.path)).length).toBeLessThanOrEqual(3);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it.each(["single commit subject", "pull request title"])(
    "uses a neutral PUT title when metadata is the entire %s",
    async (source) => {
      const metadata = `X-Claude-Session: ${SESSION_URL}`;
      const messages = source === "single commit subject"
        ? [`${metadata}\n\n${RECORD}`]
        : [`First change\n\n${RECORD}`, "Second change"];
      const body = await fixture(messages, metadata).putBody();
      expect(body.commit_title).toBe("Squash pull request (#100)");
      expect(body.commit_message).toContain(RECORD);
    },
  );

  it.each([undefined, null, "2", 0, -1, 1.5])("refuses an unusable exact commit total %s before listing or PUT", async (total) => {
    const test = fixture(["First change", "Second change"]);
    test.pull.commits = total;
    await expect(test.execute()).rejects.toThrow(/no usable exact commit total/);
    expect(test.calls.filter((call) => /\/commits\?/.test(call.path))).toHaveLength(0);
    expect(test.puts()).toHaveLength(0);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it.each([1, 3])("refuses a collected count that disagrees with exact total %s before PUT", async (total) => {
    const test = fixture(["First change", "Second change"], "A reviewed change", total);
    await expect(test.execute()).rejects.toThrow(/does not match its exact commit total/);
    expect(test.puts()).toHaveLength(0);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("refuses duplicate commits even when the count and final head agree before PUT", async () => {
    const test = fixture(["First change", "Second change"]);
    test.commits[0]!.sha = HEAD;
    await expect(test.execute()).rejects.toThrow(/does not match its exact commit total/);
    expect(test.puts()).toHaveLength(0);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("refuses a collected list that does not end at the exact head before PUT", async () => {
    const test = fixture(["First change", "Second change"]);
    test.commits[1]!.sha = "c".repeat(40);
    await expect(test.execute()).rejects.toThrow(/does not end at its exact head/);
    expect(test.puts()).toHaveLength(0);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it.each([1, 100, 101, 200, 250])("publishes every record in order for a complete %s-commit pull", async (count) => {
    const records = Array.from({ length: count }, (_, index) => `Limit: record ${index}`);
    const test = fixture(records.map((record, index) => `Change ${index}\n\n${record}`));
    const body = await test.putBody();
    expect(body.commit_message!.split("\n").filter((line) => line.startsWith("Limit:"))).toEqual(records);
    expect(body.commit_title).toBe(`${count === 1 ? "Change 0" : "A reviewed change"} (#100)`);
    expect(test.calls.filter((call) => /\/commits\?/.test(call.path)).length).toBeLessThanOrEqual(3);
  });

  it("leaves non-squash PUT fields unchanged", async () => {
    const test = fixture(["First change", "Second change"]);
    test.input.mergeStrategy = "merge_commit";
    expect(await test.putBody()).toEqual({ sha: HEAD, merge_method: "merge" });
    expect(test.calls.filter((call) => /\/commits\?/.test(call.path))).toHaveLength(0);
  });
});
