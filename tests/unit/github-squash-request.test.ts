import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { GitHubKernel, type GitHubClient, type MergeInput } from "../../src/github/github-kernel.ts";
import { boundedExecFileSync, boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { fakeGitHub } from "../helpers/fake-github-pulls.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

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
  shas?: readonly string[],
) => {
  const head = shas?.at(-1) ?? HEAD;
  const input: MergeInput = {
    runId: "test-run",
    repositoryIdentity: "github:example/project",
    pullNumber: 100,
    exactHeadSha: head,
    expectedBaseSha: BASE,
    mergeStrategy: "squash",
    ownerSessionId: "test-owner",
    ownerBindingGeneration: 1,
  };
  const pull = { number: 100, title, commits: total, head: { sha: head, ref: "feature" }, base: { sha: BASE, ref: "main" } };
  const commits = messages.map((message, index) => ({
    sha: shas?.[index] ?? (index === messages.length - 1 ? HEAD : String(index).padStart(40, "0")),
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

/**
 * The squash names the head it was merged from (S9, blocks #512): the sha the PUT fences on, and
 * nothing else. `main`'s push CI runs `pnpm merge-records HEAD~1..HEAD`, which refuses a squash
 * without exactly one `Merged-Head: <full sha>` line as unverifiable.
 */
describe("the squash PUT names the head it fences on as the merge's Merged-Head", () => {
  it("names exactly the PUT's sha, once, as the message's first paragraph", async () => {
    const body = await fixture([`First change\n\n${RECORD}`, "Second change\n\nWarn: the second record"]).putBody();
    expect(body.sha).toBe(HEAD);
    expect(body.commit_message!.split("\n").filter((line) => /merged-head/iu.test(line))).toEqual([`Merged-Head: ${body.sha}`]);
    expect(body.commit_message!.startsWith(`Merged-Head: ${body.sha}\n\n`)).toBe(true);
  });

  it("refuses a head that moved after evaluation, before any message is composed, PUT or reservation", async () => {
    const test = fixture([`First change\n\n${RECORD}`, "Second change"]);
    test.pull.head.sha = "c".repeat(40);
    const refused = await test.execute();
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_HEAD_STALE);
    expect(test.calls.filter((call) => /\/commits\?/.test(call.path))).toHaveLength(0);
    expect(test.puts()).toHaveLength(0);
    expect(test.reserve).not.toHaveBeenCalled();
  });

  /**
   * The bytes the daemon puts on the wire, committed the way GitHub composes a squash from them
   * (title, blank line, message; the head merged onto the base), then handed to the real gate.
   */
  const IDENTITY = {
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const ENV = { ...process.env, ...IDENTITY, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  const git = (cwd: string, ...args: readonly string[]): string =>
    boundedExecFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8", env: ENV }).trim();
  const commitFile = (cwd: string, file: string, message: string): void => {
    writeFileSync(file, message);
    git(cwd, "commit", "--quiet", "--no-verify", "--cleanup=verbatim", "-F", file);
  };

  const FIRST = "Limit: the first commit's record, which the squash strands mid-message";
  const LAST = "Warn: the last commit's record, in the paragraph git parses";

  it.each([
    { shape: "one commit", messages: [`feat: one change\n\nwhy.\n\n${LAST}\nX-Claude-Session: ${SESSION_URL}\n`], note: undefined },
    {
      shape: "two commits, the stranded record carried by its note",
      messages: [`feat: first change\n\nwhy.\n\n${FIRST}\n`, `fix: second change\n\nwhy.\n\n${LAST}\n`],
      note: FIRST,
    },
  ])("passes the real merge-records gate when committed as GitHub composes it ($shape)", async ({ messages, note }) => {
    const dir = tempDir("acp-daemon-squash-");
    const work = join(dir, "work");
    mkdirSync(work);
    git(work, "init", "--quiet", "-b", "main");
    writeFileSync(join(work, "a.txt"), "base\n");
    git(work, "add", "a.txt");
    commitFile(work, join(dir, "msg"), "base\n");
    const base = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "--quiet", "-b", "feature");
    const shas = messages.map((message, index) => {
      writeFileSync(join(work, "a.txt"), `change ${index}\n`);
      git(work, "add", "a.txt");
      commitFile(work, join(dir, "msg"), message);
      return git(work, "rev-parse", "HEAD");
    });
    const stored = shas.map((sha) => git(work, "log", "-1", "--format=%B", sha));

    const body = await fixture(stored, "A reviewed change", stored.length, shas).putBody();
    expect(body.sha).toBe(shas.at(-1));

    git(work, "checkout", "--quiet", "main");
    git(work, "merge", "--quiet", "--squash", "feature");
    commitFile(work, join(dir, "msg"), `${body.commit_title}\n\n${body.commit_message}`);
    const merge = git(work, "rev-parse", "HEAD");
    if (note !== undefined) {
      writeFileSync(join(dir, "note"), `${note}\n`);
      git(work, "notes", "--ref=commitlore", "add", "-F", join(dir, "note"), merge);
    }
    git(work, "remote", "add", "origin", work);

    const env = { ...fakeGitHub(dir, { 100: { merged: true, mergeCommit: merge } }), GIT_DIR: undefined, GIT_WORK_TREE: undefined };
    const gate = boundedSpawnSync(process.execPath, [join(process.cwd(), "scripts", "verify-merge-preserved-records.mjs"), `${base}..${merge}`],
      { cwd: work, env, encoding: "utf8" });
    expect(gate.status, gate.stdout).toBe(0);
    expect(gate.stdout).toContain(
      `#100  ${messages.length} record line(s) on the branch, all reachable from ${merge.slice(0, 8)} ` +
        `(the branch read up to its merge-time head ${shas.at(-1)!.slice(0, 8)})`,
    );
    expect(gate.stdout).toContain("RESULT: PASS");
  });
});
