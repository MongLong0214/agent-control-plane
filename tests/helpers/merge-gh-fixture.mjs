#!/usr/bin/env node
// The real integration fakes GitHub only. The isolated contract suite explicitly
// selects canned CLI responses; it never stands in for official semantic tests.
//
// As `gh`, it answers from one GitHub "world": the pull request `pr view` returns, the
// `project-ci` runs on each commit, and each run attempt's jobs. FIXTURE_GH_WORLD names a JSON
// file that replaces any part of the default world below; FIXTURE_GH_LOG, when set, receives
// every invocation, which is how a test observes that no merge was attempted.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (process.env.FIXTURE_CLI_RESPONSES) {
  appendFileSync(process.env.FIXTURE_CLI_LOG, JSON.stringify(args) + "\n");
  const responses = JSON.parse(readFileSync(process.env.FIXTURE_CLI_RESPONSES, "utf8"));
  if (args[0] === "validate" && !args.includes("--message-file") && !args.includes("--commit")) process.exit(2);
  if (!(args[0] in responses)) process.exit(2);
  process.stdout.write(JSON.stringify(responses[args[0]]));
} else {
  if (process.env.FIXTURE_GH_LOG) appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(args) + "\n");
  const head = process.env.FIXTURE_HEAD;
  const world = {
    pr: {
      state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "fixture",
      baseRefOid: process.env.FIXTURE_BASE, headRefOid: head,
      statusCheckRollup: [{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-02T00:00:00Z" }],
    },
    runs: [{ databaseId: 1, attempt: 1, status: "completed", headSha: head }],
    jobs: {
      "1/1": [
        { name: "verify (22.23.2)", status: "completed", conclusion: "success" },
        { name: "verify", status: "completed", conclusion: "success" },
      ],
    },
    ...(process.env.FIXTURE_GH_WORLD && existsSync(process.env.FIXTURE_GH_WORLD)
      ? JSON.parse(readFileSync(process.env.FIXTURE_GH_WORLD, "utf8"))
      : {}),
  };
  if (args[0] === "pr" && args[1] === "view") {
    if (args.includes("--jq")) process.stdout.write("fixture-no-remote-commit\n");
    else process.stdout.write(JSON.stringify(world.pr));
  } else if (args[0] === "pr" && args[1] === "merge") {
    const subject = flag("--subject");
    const body = readFileSync(flag("--body-file"), "utf8");
    if (process.env.FIXTURE_MESSAGE) writeFileSync(process.env.FIXTURE_MESSAGE, `${subject}\n\n${body}`);
  } else if (args[0] === "run" && args[1] === "list" && flag("--workflow") === "project-ci") {
    process.stdout.write(JSON.stringify(world.runs.filter((run) => run.headSha === flag("--commit"))));
  } else if (args[0] === "run" && args[1] === "view") {
    process.stdout.write(JSON.stringify({ jobs: world.jobs[`${args[2]}/${flag("--attempt")}`] ?? [] }));
  } else process.exit(2);
}
