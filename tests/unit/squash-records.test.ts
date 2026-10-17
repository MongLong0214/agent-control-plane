import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { gateReads, squashRecordPreservation } from "../../src/git/squash-records.ts";
import { composeSquashCommitMessage, composeSquashCommitTitle, squashCommitForMerge } from "../../src/github/merge-commit-message.ts";
import { boundedExecFileSync, boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const sha = (n: number): string => n.toString(16).padStart(40, "0");
const branchOf = (messages: readonly string[]) => messages.map((message, index) => ({ sha: sha(index + 1), message }));

/** `git` first on PATH for the duration of `body`, as `script` (a shell body run with git's arguments). */
const withGit = async <T>(script: (realGit: string) => string, body: () => Promise<T>): Promise<T> => {
  const realGit = boundedExecFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(tempDir("acp-squash-records-git-"), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script(realGit)}\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  try {
    return await body();
  } finally {
    process.env["PATH"] = path;
  }
};

/**
 * S9 review r2, latency: the gate reads each branch commit with two `git` processes, so a 250-commit
 * pull cost 500 of them, past 60 s on a loaded host and to the 120 s bound once. Those reads are now
 * answered from two batched processes; the gate's own `examineSquash` still decides.
 */
describe("the merge-records examination of a squash", () => {
  it("runs as many git processes for a 250-commit branch as for a 2-commit one", async () => {
    const log = join(tempDir("acp-squash-records-count-"), "invocations");
    writeFileSync(log, "");
    const count = async (size: number): Promise<{ processes: number; ids: number }> => {
      const commits = branchOf(Array.from({ length: size }, (_, index) =>
        `change ${index}\n\nwhy ${index}.\n\nLimit: limit ${index}\nRecord-Id: r-${String(index).padStart(12, "0")}\n`));
      const title = composeSquashCommitTitle(commits, "A reviewed change", 100);
      const message = composeSquashCommitMessage(commits, commits.at(-1)!.sha);
      const before = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
      const kept = await withGit((realGit) => `printf '%s\\n' "$1" >> '${log}'\nexec '${realGit}' "$@"`,
        () => squashRecordPreservation(commits, title, message, commits.at(-1)!.sha, 100));
      return { processes: readFileSync(log, "utf8").split("\n").filter(Boolean).length - before, ids: kept.recordIds.length };
    };
    const small = await count(2);
    const large = await count(250);
    // Every record but the last commit's is stranded mid-message: the answer is the gate's, at any size.
    expect(small.ids).toBe(1);
    expect(large.ids).toBe(249);
    expect(large.processes).toBe(small.processes);
  });

  it("answers each gate read exactly as the gate's own per-commit git calls do", async () => {
    const messages = [
      "plain subject only\n",
      "Limit: a subject that looks like a trailer\n",
      "feat: kept\n\nwhy.\n\nLimit: kept\nRecord-Id: r-000000000001\n",
      "feat: kept\n\nwhy.\n\nLimit: kept\nRecord-Id: r-000000000001\n",
      "fix: divider\n\nLimit: before a divider\n---\nWarn: after the divider\n",
      "docs: folded\n\nKey: value\n  folded continuation\nRecord-Id: r-000000000002",
      "crlf\r\n\r\nLimit: a crlf line\r\nRecord-Id: r-000000000003\r\n",
      "unicode — 한국어\n\nWarn: 값 ünïcode\n",
      "",
      "trailing blanks\n\nLimit: x\n\n\n\n",
      "prose then\n\nnot a trailer\nLimit: half\n",
      "comment\n\n# a comment line\nLimit: after a comment\n",
      "Merged-Head: 1111111111111111111111111111111111111111\n\nsquash body\n\nWarn: last\nRecord-Id: r-000000000004\n",
    ];
    const dir = tempDir("acp-squash-records-reads-");
    const env = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: dir,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (args: readonly string[], input?: string) =>
      boundedSpawnSync("git", args, { cwd: dir, env, encoding: "utf8", ...(input === undefined ? {} : { input }) });
    expect(git(["init", "--quiet"]).status).toBe(0);
    const stamp = "committer fixture <fixture@example.invalid> 0 +0000\n";
    const stream = messages.map((message, index) =>
      `commit refs/heads/branch\nmark :${index + 1}\n${stamp}data ${Buffer.byteLength(message, "utf8")}\n${message}\n` +
      (index === 0 ? "" : `from :${index}\n`)).join("") + "done\n";
    expect(git(["fast-import", "--quiet", "--done", "--export-marks=marks"], stream).status).toBe(0);
    const shas = readFileSync(join(dir, "marks"), "utf8").trim().split("\n").map((line) => line.split(" ")[1]!);
    expect(shas).toHaveLength(messages.length);

    const reads = await gateReads(dir, env, shas);
    for (const commit of shas) {
      // The gate's `storedTrailers`: these two calls, in this order, for every commit it reads.
      const body = git(["log", "-1", "--format=%B", commit]).stdout;
      expect(reads.messages.get(commit)).toBe(body);
      expect(reads.trailers.get(body)).toBe(git(["interpret-trailers", "--parse"], body).stdout);
    }
    expect(reads.trailers.get(reads.messages.get(shas[4]!)!)).toBe("Limit: before a divider\n");
  });

  it("refuses a merge whose examination outlives its bound, naming the timeout, and never allows it", async () => {
    const commits = branchOf(["feat: first\n\nwhy.\n", "fix: second\n\nwhy.\n"]);
    const decision = await withGit(() => "exec /bin/sleep 5",
      () => squashCommitForMerge(commits, "A reviewed change", 100, commits.at(-1)!.sha, 300));
    if (decision.allowed) throw new Error("a merge whose examination timed out was allowed");
    expect(decision.reasonCode).toBe(ReasonCode.GIT_TIMEOUT);
    expect(decision.message).toContain("did not finish within its 300ms bound");
    expect(decision.evidence).toMatchObject({ pullNumber: 100, mergedHead: commits.at(-1)!.sha, timeoutMs: 300 });
  });
});
