#!/usr/bin/env node
// The real integration fakes GitHub only. The isolated contract suite explicitly
// selects canned CLI responses; it never stands in for official semantic tests.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FIXTURE_CLI_RESPONSES) {
  appendFileSync(process.env.FIXTURE_CLI_LOG, JSON.stringify(args) + "\n");
  const responses = JSON.parse(readFileSync(process.env.FIXTURE_CLI_RESPONSES, "utf8"));
  if (args[0] === "validate" && !args.includes("--message-file") && !args.includes("--commit")) process.exit(2);
  if (!(args[0] in responses)) process.exit(2);
  process.stdout.write(JSON.stringify(responses[args[0]]));
} else if (args[0] === "pr" && args[1] === "view") {
  if (args.includes("--jq")) process.stdout.write("fixture-no-remote-commit\n");
  else process.stdout.write(JSON.stringify({
    state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "fixture",
    baseRefOid: process.env.FIXTURE_BASE, headRefOid: process.env.FIXTURE_HEAD,
    statusCheckRollup: [{ name: "fixture", status: "COMPLETED", conclusion: "SUCCESS" }],
  }));
} else if (args[0] === "pr" && args[1] === "merge") {
  const subject = args[args.indexOf("--subject") + 1];
  const body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
  writeFileSync(process.env.FIXTURE_MESSAGE, `${subject}\n\n${body}`);
} else process.exit(2);
