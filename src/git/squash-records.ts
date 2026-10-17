/**
 * The merge-records gate's own `examineSquash`, asked before a squash exists.
 *
 * This is the subprocess half of the daemon's squash check and lives outside `src/github` on
 * purpose: nothing on the GitHub path imports the means to spawn (P1-14, `tests/unit/github-r2.test.ts`),
 * so no child there can carry the App token. The children here get a minimal environment built
 * below, never the daemon's own, exactly as `git.ts` does for every other git call.
 */
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { acpScratchDir } from "../core/scratch-root.ts";

/**
 * `scripts/verify-merge-preserved-records.mjs`, the check `main`'s push CI runs. `src/git` and the
 * built `dist/git`, like `src/github` and `dist/github`, sit two levels under the root whose
 * `scripts/` the deployed generation ships, so this one address serves both.
 */
export const MERGE_RECORDS_GATE = new URL("../../scripts/verify-merge-preserved-records.mjs", import.meta.url);

/** A full commit sha, as the gate reads one. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A branch record line the squash's trailer block would not keep, and the branch commit that carried it. */
export interface UnpreservedRecordLine {
  readonly commit: string;
  readonly line: string;
}

/** What the merge-records gate would find, asked before the merge rather than after it. */
export interface SquashRecordPreservation {
  /** Record lines the branch carries, counted as the gate counts them. */
  readonly carried: number;
  readonly unpreserved: readonly UnpreservedRecordLine[];
  /** The Record-Ids of the commits those lines came from, each once, in branch order. */
  readonly recordIds: readonly string[];
  /** Commits with an unpreserved line and no Record-Id to name it by. */
  readonly commitsWithoutRecordId: readonly string[];
}

const execFileAsync = promisify(execFile);
const PRESERVATION_TIMEOUT_MS = 120_000;

/** The gate's `examineSquash`, run where its git calls land: a child whose cwd is the fixture repository. */
const EXAMINE_SQUASH = [
  "const [gate, squash, pull] = process.argv.slice(1);",
  "const { examineSquash } = await import(gate);",
  "const { carried, missing } = examineSquash(squash, pull);",
  "process.stdout.write(JSON.stringify({ carried: carried.size, missing }));",
].join("\n");

const isExamination = (value: unknown): value is { carried: number; missing: Array<[string, string]> } => {
  if (typeof value !== "object" || value === null) return false;
  const { carried, missing } = value as { carried?: unknown; missing?: unknown };
  return Number.isSafeInteger(carried) && Array.isArray(missing) && missing.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string");
};

/**
 * Whether the squash's own trailer block keeps every record line the branch carries, decided by the
 * merge-records gate's own `examineSquash` rather than by a second rule.
 *
 * The squash does not exist before the merge, so it is built: a private repository holding the
 * branch's messages as a chain of commits and `title`, a blank line and `message` as the squash on
 * their base — the bytes GitHub commits. The only change is the `Merged-Head` value, which must name
 * the fixture's head for the gate to read the branch. That repository has no notes ref, so the answer
 * is what the trailer block alone keeps: this daemon writes no CommitLore notes mirror.
 *
 * Any failure throws; the caller runs this before the merge is reserved.
 */
export const squashRecordPreservation = async (
  commits: readonly { readonly sha: string; readonly message: string }[],
  title: string,
  message: string,
  mergedHead: string,
  pullNumber: number,
): Promise<SquashRecordPreservation> => {
  if (commits.length === 0) throw new Error("a squash with no branch commits cannot be examined");
  const declared = `Merged-Head: ${mergedHead}`;
  const lines = `${title}\n\n${message}`.split("\n");
  if (lines.filter((line) => line === declared).length !== 1) {
    throw new Error("the squash message does not name the head this merge fences on exactly once");
  }

  const dir = acpScratchDir("squash-records-");
  // No operator or system configuration: a trailer or identity setting there would make this answer
  // differ from the gate's on CI. The identity is the fixture's own.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    GIT_AUTHOR_NAME: "acp",
    GIT_AUTHOR_EMAIL: "acp@invalid",
    GIT_COMMITTER_NAME: "acp",
    GIT_COMMITTER_EMAIL: "acp@invalid",
  };
  const run = async (file: string, args: readonly string[], input?: string): Promise<string> => {
    const pending = execFileAsync(file, args, {
      cwd: dir,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: PRESERVATION_TIMEOUT_MS,
    });
    pending.child.stdin?.end(input ?? "");
    return (await pending).stdout;
  };
  try {
    await run("git", ["init", "--quiet"]);
    // The base, then the branch as one chain on it, in one process: one `git` per commit costs
    // seconds on a 250-commit pull. Every commit has the empty tree; the gate reads only messages.
    const stamp = "committer acp <acp@invalid> 0 +0000\n";
    const data = (text: string): string => `data ${Buffer.byteLength(text, "utf8")}\n${text}\n`;
    const stream = [
      `commit refs/heads/base\nmark :1\n${stamp}${data("base\n")}`,
      ...commits.map((commit, index) =>
        `commit refs/heads/branch\nmark :${index + 2}\n${stamp}${data(commit.message)}from :${index + 1}\n`),
      "done\n",
    ].join("");
    await run("git", ["fast-import", "--quiet", "--done", "--export-marks=marks"], stream);
    const marks = new Map(readFileSync(join(dir, "marks"), "utf8").split("\n").filter(Boolean).map((line) => {
      const [mark, sha] = line.split(" ");
      return [Number(mark?.slice(1)), sha ?? ""] as const;
    }));
    const base = marks.get(1);
    const branch = commits.map((_, index) => marks.get(index + 2) ?? "");
    const head = branch.at(-1)!;
    if (base === undefined || branch.some((sha) => !FULL_SHA.test(sha))) {
      throw new Error("the squash fixture's commits could not be read back");
    }

    writeFileSync(join(dir, "squash"), lines.map((line) => (line === declared ? `Merged-Head: ${head}` : line)).join("\n"));
    const squash = (await run("git", ["commit-tree", "-p", base, "-F", "squash", `${head}^{tree}`])).trim();

    const examined: unknown = JSON.parse(
      await run(process.execPath, ["--input-type=module", "-e", EXAMINE_SQUASH, MERGE_RECORDS_GATE.href, squash, String(pullNumber)]),
    );
    if (!isExamination(examined)) throw new Error("the merge-records gate's examination could not be read");

    const unpreserved = examined.missing.map(([line, from]) => {
      const index = branch.indexOf(from);
      if (index === -1) throw new Error("the merge-records gate named a commit outside the branch");
      return { index, line };
    });
    // The Record-Ids of the commits that lose a line, read from each commit's stored trailers in one
    // `git log`, which parses trailers as `git interpret-trailers` does.
    const losing = [...new Set(unpreserved.map((entry) => entry.index))].sort((a, b) => a - b);
    const trailers = losing.length === 0 ? [] : (await run("git", [
      "log", "--no-walk=unsorted", "--format=%(trailers:only,unfold)%x1e", ...losing.map((index) => branch[index]!),
    ])).split("\x1e");
    const recordIds: string[] = [];
    const commitsWithoutRecordId: string[] = [];
    for (const [position, index] of losing.entries()) {
      const ids = (trailers[position] ?? "")
        .split("\n")
        .map((line) => /^Record-Id:\s*(\S.*)$/u.exec(line.trim())?.[1]?.trim())
        .filter((id): id is string => id !== undefined);
      if (ids.length === 0) commitsWithoutRecordId.push(commits[index]!.sha);
      for (const id of ids) if (!recordIds.includes(id)) recordIds.push(id);
    }
    return {
      carried: examined.carried,
      unpreserved: unpreserved.map(({ index, line }) => ({ commit: commits[index]!.sha, line })),
      recordIds,
      commitsWithoutRecordId,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
