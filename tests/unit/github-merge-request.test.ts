import { describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { type GatePayload, GitHubKernel, type GitHubClient, type MergeInput } from "../../src/github/github-kernel.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

/**
 * #1269 — the real mergeExecute through its PUT, with authorization already satisfied. The transport stops
 * at that boundary: these tests make no claim about post-merge proof or auth.
 */
const fixture = (mergeStrategy: MergeInput["mergeStrategy"], compared = "ahead") => {
  const input: MergeInput = {
    runId: "test-run",
    repositoryIdentity: "github:example/project",
    pullNumber: 100,
    exactHeadSha: HEAD,
    expectedBaseSha: BASE,
    mergeStrategy,
    ownerSessionId: "test-owner",
    ownerBindingGeneration: 1,
  };
  const pull = { number: 100, title: "A reviewed change", commits: 1, merged: false, head: { sha: HEAD, ref: "feature" }, base: { sha: BASE, ref: "main" } };
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const putReached = new Error("PUT captured");
  const client: GitHubClient = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (method === "PUT" && path === "/repos/example/project/pulls/100/merge") throw putReached;
      if (method === "GET" && path === "/repos/example/project/pulls/100") return structuredClone(pull) as T;
      if (method === "GET" && path === `/repos/example/project/compare/${BASE}...${HEAD}`) return { status: compared } as T;
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
    evaluateMerge: async () => allow(ReasonCode.OK, { predicates: {}, gate: {} as GatePayload }),
    assertGatePayloadBacked: () => allow(ReasonCode.OK, undefined),
    preparedPrIntent: () => allow(ReasonCode.OK, { head: "feature", base: "main" }),
    api: () => client,
    writeTarget: () => allow(ReasonCode.OK, {}),
    reserveReceipt: reserve,
    mediate: async (...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(),
  });
  return { execute: () => kernel.mergeExecute(input), calls, reserve, putReached };
};

describe("the merge request is a merge commit and nothing else (#1269)", () => {
  it("sends exactly the head fence and merge_method merge, and composes no message", async () => {
    const test = fixture("merge_commit");
    await expect(test.execute()).rejects.toBe(test.putReached);
    expect(test.calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([{ sha: HEAD, merge_method: "merge" }]);
    expect(test.calls.some((call) => call.path.includes("/commits"))).toBe(false);
  });

  it.each(["squash", "rebase", "fast_forward"] as const)("refuses a %s request before anything is reserved or sent", async (strategy) => {
    const test = fixture(strategy);
    const refused = await test.execute();
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED);
    if (refused.allowed) throw new Error("not refused");
    expect(refused.evidence).toMatchObject({ mergeStrategy: strategy, pullMerged: false });
    expect(test.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it.each(["diverged", "behind"])("refuses a head whose compare with the base is %s before anything is reserved or sent", async (status) => {
    const test = fixture("merge_commit", status);
    const refused = await test.execute();
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(test.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(test.reserve).not.toHaveBeenCalled();
  });
});
