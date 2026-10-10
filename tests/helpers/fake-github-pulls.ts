import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An offline stand-in for the `gh api` call `scripts/verify-merge-preserved-records.mjs` makes,
 * answering in `gh`'s own shape: `gh api --include repos/{repo}/pulls/N` prints the HTTP status
 * line, headers, a blank line and the body, exiting 1 on a non-2xx status. A number with no
 * fixture answers 404 with GitHub's own not-found body. The gate runs it through
 * `ACP_MERGE_RECORDS_GH`.
 *
 * It also answers `gh api --paginate --jq .[].sha repos/{repo}/pulls/N/commits`, one sha per line,
 * which the gate no longer calls: every invocation is logged, so a test can show the commit list
 * is never what attributes a commit, however it is answered.
 */
export interface FakePull {
  /** HTTP status of the pull request call (200 when omitted). */
  readonly status?: number;
  /** A body to print instead of the composed JSON, e.g. one that does not parse. */
  readonly raw?: string;
  /** Exit with this status and print nothing, as a failed connection does. */
  readonly exit?: number;
  /** Print the answer as usual, then exit with this status instead of `gh`'s own. */
  readonly exitWith?: number;
  readonly merged?: boolean;
  readonly mergeCommit?: string | null;
  /** The pull request's current `head.sha`, which moves after a merge and which the gate ignores. */
  readonly head?: string;
  /** The commit list endpoint's answer; `commitsCount` (the body's `commits`) defaults to its length. */
  readonly commits?: readonly string[];
  readonly commitsCount?: number;
  /** The commit list call fails. */
  readonly commitsFail?: boolean;
}

/** GitHub's body for a pull request number that is not one (an issue, or nothing). */
export const GITHUB_NOT_FOUND = JSON.stringify({
  message: "Not Found",
  documentation_url: "https://docs.github.com/rest/pulls/pulls#get-a-pull-request",
  status: "404",
});

const SCRIPT = `
const fs = require("node:fs");
const fixtures = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const target = args[args.length - 1] || "";
const pullCall = /^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)$/.exec(target);
const commitsCall = /^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)\\/commits$/.exec(target);
if (args[0] !== "api") process.exit(2);
if (pullCall && args.includes("--include")) {
  const pull = fixtures[pullCall[1]];
  const status = pull ? (pull.status ?? 200) : 404;
  if (pull && pull.exit !== undefined) process.exit(pull.exit);
  const body = pull && pull.raw !== undefined ? pull.raw : pull && status === 200
    ? JSON.stringify({ number: Number(pullCall[1]), merged: pull.merged ?? false, merge_commit_sha: pull.mergeCommit ?? null,
      head: { sha: pull.head ?? null }, commits: pull.commitsCount ?? (pull.commits || []).length })
    : process.env.FAKE_GH_NOT_FOUND;
  const text = { 200: "OK", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway" }[status] || "Status";
  process.stdout.write("HTTP/2.0 " + status + " " + text + "\\r\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n" + body);
  if (status >= 400) process.stderr.write("gh: " + text + " (HTTP " + status + ")\\n");
  process.exit(pull && pull.exitWith !== undefined ? pull.exitWith : status >= 200 && status < 300 ? 0 : 1);
}
if (commitsCall && args.includes("--paginate")) {
  const pull = fixtures[commitsCall[1]];
  if (!pull || pull.commitsFail) process.exit(1);
  process.stdout.write((pull.commits || []).map((sha) => sha + "\\n").join(""));
  process.exit(0);
}
process.exit(2);
`;

/** Writes the fake and its answers under `dir`, and returns the environment the gate runs in. */
export const fakeGitHub = (
  dir: string,
  pulls: Readonly<Record<number, FakePull>>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const executable = join(dir, "fake-gh");
  const fixtures = join(dir, "fake-gh.json");
  writeFileSync(executable, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(executable, 0o755);
  writeFileSync(fixtures, JSON.stringify(pulls));
  writeFileSync(join(dir, "fake-gh.log"), "");
  return {
    ...base, ACP_MERGE_RECORDS_GH: executable, FAKE_GH_FIXTURES: fixtures, FAKE_GH_LOG: join(dir, "fake-gh.log"),
    FAKE_GH_NOT_FOUND: GITHUB_NOT_FOUND, GITHUB_REPOSITORY: "test/repo",
  };
};

/** Every `gh` invocation the fake under `dir` answered since `fakeGitHub` last wrote it. */
export const fakeGitHubCalls = (dir: string): string[][] => {
  const log = join(dir, "fake-gh.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
};
