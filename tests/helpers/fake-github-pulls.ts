import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An offline stand-in for the two `gh api` calls `scripts/verify-merge-preserved-records.mjs`
 * makes, answering in `gh`'s own shapes: `gh api --include repos/{repo}/pulls/N` prints the HTTP
 * status line, headers, a blank line and the body, exiting 1 on a non-2xx status; `gh api --paginate
 * --jq .[].sha repos/{repo}/pulls/N/commits` prints one sha per line. The gate runs it through
 * `ACP_MERGE_RECORDS_GH`.
 */
export interface FakePull {
  /** HTTP status of the pull request call (200 when omitted). */
  readonly status?: number;
  /** A body to print instead of the composed JSON, e.g. one that does not parse. */
  readonly raw?: string;
  /** Exit with this status and print nothing, as a failed connection does. */
  readonly exit?: number;
  readonly merged?: boolean;
  readonly mergeCommit?: string | null;
  readonly head?: string;
  /** The commit list; `commitsCount` defaults to its length. */
  readonly commits?: readonly string[];
  readonly commitsCount?: number;
  /** The commit list call fails. */
  readonly commitsFail?: boolean;
}

const SCRIPT = `
const fs = require("node:fs");
const fixtures = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURES, "utf8"));
const args = process.argv.slice(2);
const target = args[args.length - 1] || "";
const pullCall = /^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)$/.exec(target);
const commitsCall = /^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)\\/commits$/.exec(target);
if (args[0] !== "api") process.exit(2);
if (pullCall && args.includes("--include")) {
  const pull = fixtures[pullCall[1]];
  const status = pull ? (pull.status ?? 200) : 404;
  if (pull && pull.exit !== undefined) process.exit(pull.exit);
  const body = pull && pull.raw !== undefined ? pull.raw : pull
    ? JSON.stringify({ number: Number(pullCall[1]), merged: pull.merged ?? false, merge_commit_sha: pull.mergeCommit ?? null,
      head: { sha: pull.head }, commits: pull.commitsCount ?? (pull.commits || []).length })
    : JSON.stringify({ message: "Not Found", status: "404" });
  const text = { 200: "OK", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway" }[status] || "Status";
  process.stdout.write("HTTP/2.0 " + status + " " + text + "\\r\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n" + body);
  if (status >= 400) process.stderr.write("gh: " + text + " (HTTP " + status + ")\\n");
  process.exit(status >= 200 && status < 300 ? 0 : 1);
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
  return { ...base, ACP_MERGE_RECORDS_GH: executable, FAKE_GH_FIXTURES: fixtures, GITHUB_REPOSITORY: "test/repo" };
};
