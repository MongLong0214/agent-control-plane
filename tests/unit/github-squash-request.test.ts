import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { type GatePayload, GitHubKernel, type GitHubClient, type MergeInput } from "../../src/github/github-kernel.ts";
import { composeSquashCommitMessage, composeSquashCommitTitle } from "../../src/github/merge-commit-message.ts";
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
    // The evaluation names the gate payload it selected; mergeExecute verifies that payload again after its
    // last awaited read and before the PUT (FD-R1-RACE). Authorization is satisfied here, so both allow.
    evaluateMerge: async () => allow(ReasonCode.OK, { predicates: {}, gate: {} as GatePayload }),
    assertGatePayloadBacked: () => allow(ReasonCode.OK, undefined),
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
      // The record sits in the last commit's trailer block, the one block a squash keeps as trailers.
      const messages = source === "single commit subject"
        ? [`${dirtyTitle}\n\n${RECORD}\nX-Claude-Session: ${SESSION_URL}`]
        : [`First change\n\nX-Claude-Session: ${SESSION_URL}`, `Second change\n\n${RECORD}\nClaude-Session: ${SESSION_URL}`];
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
        : ["First change", `Second change\n\n${RECORD}`];
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

  // Bodies rather than records: a record in an earlier commit is refused (S9-R1, below), and what
  // this pins is that every page of the branch reaches the PUT, in order.
  it.each([1, 100, 101, 200, 250])("publishes every commit body in order for a complete %s-commit pull", async (count) => {
    const bodies = Array.from({ length: count }, (_, index) => `body line ${index}.`);
    const test = fixture(bodies.map((body, index) => `Change ${index}\n\n${body}`));
    const body = await test.putBody();
    expect(body.commit_message!.split("\n").filter((line) => line.startsWith("body line "))).toEqual(bodies);
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
    const body = await fixture(["First change\n\nwhy the first change.", `Second change\n\n${RECORD}\nWarn: the second record`]).putBody();
    expect(body.sha).toBe(HEAD);
    expect(body.commit_message!.split("\n").filter((line) => /merged-head/iu.test(line))).toEqual([`Merged-Head: ${body.sha}`]);
    expect(body.commit_message!.startsWith(`Merged-Head: ${body.sha}\n\n`)).toBe(true);
  });

  it("refuses a head that moved after evaluation, before any message is composed, PUT or reservation", async () => {
    const test = fixture(["First change", `Second change\n\n${RECORD}`]);
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

  /** A real repository: a base commit on `main`, then `messages` as the commits of `feature`. */
  const branchRepository = (messages: readonly string[]) => {
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
    return { dir, work, base, shas, stored };
  };

  /**
   * `title` and `message` committed as GitHub squashes `feature` onto `main`, then the real gate on
   * it. `hypotheticalNote` exists for one labelled witness only: what the gate would accept if a
   * notes mirror were written. This daemon writes none, so no other witness may pass one.
   */
  const squashAndGate = (
    repository: ReturnType<typeof branchRepository>,
    title: string,
    message: string,
    hypotheticalNote?: string,
  ) => {
    const { dir, work, base } = repository;
    git(work, "checkout", "--quiet", "main");
    git(work, "merge", "--quiet", "--squash", "feature");
    commitFile(work, join(dir, "msg"), `${title}\n\n${message}`);
    const merge = git(work, "rev-parse", "HEAD");
    if (hypotheticalNote !== undefined) {
      writeFileSync(join(dir, "note"), `${hypotheticalNote}\n`);
      git(work, "notes", "--ref=commitlore", "add", "-F", join(dir, "note"), merge);
    }
    git(work, "remote", "add", "origin", work);
    const env = { ...fakeGitHub(dir, { 100: { merged: true, mergeCommit: merge } }), GIT_DIR: undefined, GIT_WORK_TREE: undefined };
    const gate = boundedSpawnSync(process.execPath, [join(process.cwd(), "scripts", "verify-merge-preserved-records.mjs"), `${base}..${merge}`],
      { cwd: work, env, encoding: "utf8" });
    return { merge, gate };
  };

  it.each([
    { shape: "one commit", messages: [`feat: one change\n\nwhy.\n\n${LAST}\nX-Claude-Session: ${SESSION_URL}\n`] },
  ])("passes the real merge-records gate when committed as GitHub composes it ($shape)", async ({ messages }) => {
    const repository = branchRepository(messages);
    const { shas, stored } = repository;

    const body = await fixture(stored, "A reviewed change", stored.length, shas).putBody();
    expect(body.sha).toBe(shas.at(-1));

    const { merge, gate } = squashAndGate(repository, body.commit_title!, body.commit_message!);
    expect(gate.status, gate.stdout).toBe(0);
    expect(gate.stdout).toContain(
      `#100  ${messages.length} record line(s) on the branch, all reachable from ${merge.slice(0, 8)} ` +
        `(the branch read up to its merge-time head ${shas.at(-1)!.slice(0, 8)})`,
    );
    expect(gate.stdout).toContain("RESULT: PASS");
  });

  /**
   * S9 review r1, R2: the gate reads the title too. A title opening `Merged-Head:` — a single
   * commit's subject, or a multi-commit pull request's title — reached the PUT, and the real gate
   * then refused the committed squash as naming two. The squash is now read with the gate's own
   * `mergedHeadIn`, title included, before anything is reserved or sent.
   */
  it.each([
    {
      source: "a single commit's subject",
      messages: [`Merged-Head: update documentation\n\nwhy.\n\n${LAST}\n`],
      title: "A reviewed change",
    },
    {
      source: "a multi-commit pull request's title",
      messages: [`feat: first change\n\nwhy.\n\n${FIRST}\n`, `fix: second change\n\nwhy.\n\n${LAST}\n`],
      title: "Merged-Head: update documentation",
    },
  ])("refuses a title declaring a Merged-Head ($source) before reservation or PUT, as the real gate would", async ({ messages, title }) => {
    const repository = branchRepository(messages);
    const { shas, stored } = repository;

    const test = fixture(stored, title, stored.length, shas);
    await expect(test.execute()).rejects.toThrow(/conflicting Merged-Head trailers/);
    expect(test.puts()).toHaveLength(0);
    expect(test.reserve).not.toHaveBeenCalled();

    // Why: the same bytes, had they been sent, are a squash the real gate refuses for good.
    const branch = stored.map((message, index) => ({ sha: shas[index]!, message }));
    const { gate } = squashAndGate(
      repository,
      composeSquashCommitTitle(branch, title, 100),
      composeSquashCommitMessage(branch, shas.at(-1)!),
    );
    expect(gate.status, gate.stdout).toBe(1);
    expect(gate.stdout).toContain("2 conflicting Merged-Head trailers");
  });

  /**
   * S9 review r1, R1: a squash keeps as trailers only its last paragraph, so a record from an earlier
   * commit survives only in a CommitLore notes mirror, which this daemon does not write. The daemon
   * now asks the gate's own `examineSquash`, before the reservation, whether the trailer block alone
   * keeps every record line the branch carries; it refuses when it does not, naming the records.
   * Each witness also commits the same bytes and runs the real gate, which must agree.
   */
  describe("a squash proceeds only when its trailer block alone keeps every record the gate requires", () => {
    const id = (letter: string): string => `r-${letter.repeat(12)}`;
    /** Advice the refusal must never give: the records and the history stay as they are. */
    const FORBIDDEN_ADVICE = /squash (?:the |its |these )?records|into one commit|delete|remove|rewrite|amend|rebase|force|renam|change (?:the |its )?(?:record-)?ids?/iu;

    const refusedBeforeAnyWrite = async (test: ReturnType<typeof fixture>) => {
      const decision = await test.execute();
      if (decision.allowed) throw new Error("the squash was not refused");
      expect(decision.reasonCode).toBe(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED);
      expect(test.reserve).not.toHaveBeenCalled();
      expect(test.calls.filter((call) => call.method !== "GET")).toEqual([]);
      expect(decision.message).toContain("notes mirror, which this daemon does not support");
      expect(decision.message).toContain("official preservation path");
      expect(decision.message).not.toMatch(FORBIDDEN_ADVICE);
      return decision;
    };

    it.each([
      { shape: "no record on several commits", records: 0, messages: ["feat: first\n\nwhy.\n", "fix: second\n\nmore why.\n"] },
      {
        shape: "one record, in the last of several commits",
        records: 2,
        messages: ["feat: first\n\nwhy.\n", `fix: second\n\nwhy.\n\n${LAST}\nRecord-Id: ${id("a")}\n`],
      },
      {
        shape: "a duplicate Record-Id the last commit restates whole",
        records: 2,
        messages: [
          `feat: first\n\nLimit: the restated record\nRecord-Id: ${id("d")}\n`,
          `fix: second\n\nLimit: the restated record\nRecord-Id: ${id("d")}\n`,
        ],
      },
    ])("proceeds, and the real gate passes the bytes it sent ($shape)", async ({ messages, records }) => {
      const repository = branchRepository(messages);
      const { shas, stored } = repository;
      const test = fixture(stored, "A reviewed change", stored.length, shas);
      const body = await test.putBody();
      expect(test.reserve).toHaveBeenCalledTimes(1);

      const { merge, gate } = squashAndGate(repository, body.commit_title!, body.commit_message!);
      expect(gate.status, gate.stdout).toBe(0);
      expect(gate.stdout).toContain(`#100  ${records} record line(s) on the branch, all reachable from ${merge.slice(0, 8)}`);
    });

    it.each([
      {
        shape: "several commits and several records needing notes",
        messages: [
          `feat: first\n\nwhy.\n\nLimit: the first record\nRecord-Id: ${id("a")}\n`,
          `fix: second\n\nWarn: the second record\nRecord-Id: ${id("b")}\n`,
          `docs: third\n\nLimit: the third record\nRecord-Id: ${id("c")}\n`,
        ],
        ids: [id("a"), id("b")],
        lines: 4,
      },
      {
        shape: "a duplicate Record-Id whose earlier copy says more than the last",
        messages: [
          `feat: first\n\nLimit: what the first copy says\nRecord-Id: ${id("d")}\n`,
          `fix: second\n\nLimit: what the second copy says\nRecord-Id: ${id("d")}\n`,
        ],
        ids: [id("d")],
        lines: 1,
      },
      {
        // Present as text, even in the last paragraph, which a prose line keeps from being a trailer
        // block: a search of the message would call it carried (commitlore#1029); the gate does not.
        shape: "a record in the body text but in no valid trailer block",
        messages: [
          `feat: first\n\nLimit: the text-only record\nRecord-Id: ${id("e")}\n`,
          `fix: second\n\nLimit: the text-only record\nRecord-Id: ${id("e")}\nrestated above this prose line, so git reads no trailer block here\n`,
        ],
        ids: [id("e")],
        lines: 2,
      },
    ])("refuses before the reservation with zero GitHub writes, naming the records ($shape)", async ({ messages, ids, lines }) => {
      const repository = branchRepository(messages);
      const { shas, stored } = repository;
      const refused = await refusedBeforeAnyWrite(fixture(stored, "A reviewed change", stored.length, shas));
      expect(refused.evidence["unpreservedRecordIds"]).toEqual(ids);
      expect(refused.evidence["unpreservedRecordLines"]).toBe(lines);
      expect(refused.evidence["commitsWithoutRecordId"]).toEqual([]);
      for (const name of ids) expect(refused.message.split(name)).toHaveLength(2);

      // The real gate, on the bytes the daemon declined to send, refuses the same lines.
      const branch = stored.map((message, index) => ({ sha: shas[index]!, message }));
      const message = composeSquashCommitMessage(branch, shas.at(-1)!);
      for (const name of ids) expect(message).toContain(`Record-Id: ${name}`);
      const { gate } = squashAndGate(repository, composeSquashCommitTitle(branch, "A reviewed change", 100), message);
      expect(gate.status, gate.stdout).toBe(1);
      expect(gate.stdout).toContain(`${lines} record line(s) the branch carried and this merge does not keep`);
    });

    it("names the commit when a lost record line has no Record-Id", async () => {
      const repository = branchRepository(["feat: first\n\nLimit: a record line with no id\n", "fix: second\n\nwhy.\n"]);
      const { shas, stored } = repository;
      const refused = await refusedBeforeAnyWrite(fixture(stored, "A reviewed change", stored.length, shas));
      expect(refused.evidence["unpreservedRecordIds"]).toEqual([]);
      expect(refused.evidence["commitsWithoutRecordId"]).toEqual([shas[0]]);
      expect(refused.message).toContain(shas[0]!);
    });

    /**
     * HYPOTHETICAL, labelled as such: what the gate WOULD accept had a notes mirror carried the
     * stranded record. This daemon writes no note; the witness shows only that the refusal above is
     * about the mirror and nothing else.
     */
    it("HYPOTHETICAL: the gate would accept the refused bytes only with a notes mirror this daemon does not write", async () => {
      const messages = [`feat: first\n\nwhy.\n\n${FIRST}\n`, `fix: second\n\nwhy.\n\n${LAST}\n`];
      const repository = branchRepository(messages);
      const { shas, stored } = repository;
      await refusedBeforeAnyWrite(fixture(stored, "A reviewed change", stored.length, shas));

      const branch = stored.map((message, index) => ({ sha: shas[index]!, message }));
      const title = composeSquashCommitTitle(branch, "A reviewed change", 100);
      const { gate } = squashAndGate(repository, title, composeSquashCommitMessage(branch, shas.at(-1)!), FIRST);
      expect(gate.status, gate.stdout).toBe(0);
    });
  });
});

/**
 * S9 review r2, R1: the gate maps each lost line to one commit, the newest carrying it. Two records
 * sharing a `Limit:` both lose it, and a later commit restating one of their ids without it does not
 * keep it for that record. The refusal names every record that loses a line, not the gate's one.
 */
it("FOLLOWUP: names both records whose shared constraint is lost, including a partially restated duplicate ID", async () => {
  const messages = [
    "first\n\nLimit: the shared constraint\nRecord-Id: r-aaaaaa\n",
    "second\n\nLimit: the shared constraint\nRecord-Id: r-bbbbbb\n",
    "third\n\nWarn: the final warning\nRecord-Id: r-aaaaaa\n",
  ];
  const test = fixture(messages);
  const refused = await test.execute();
  expect(refused.allowed).toBe(false);
  expect(test.reserve).not.toHaveBeenCalled();
  expect(test.calls.filter((call) => call.method !== "GET")).toEqual([]);
  if (refused.allowed) throw new Error("not refused");
  expect(refused.evidence["unpreservedRecordIds"]).toEqual(["r-aaaaaa", "r-bbbbbb"]);
});
