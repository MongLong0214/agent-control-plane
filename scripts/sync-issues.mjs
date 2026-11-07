#!/usr/bin/env node
/**
 * Projects docs/tickets/tickets.json onto GitHub milestones and issues.
 *
 * Idempotent by marker: an issue whose body carries `<!-- acp-ticket:T0xx -->` is
 * updated in place rather than duplicated, so re-running after a ticket edit converges.
 * The ticket file stays the portable contract; the issue is a projection
 * (Integration §17.3).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ticketIssueBody } from "./lib/ticket-issue-body.mjs";

const REPO = process.env.ACP_ISSUE_REPO ?? "MongLong0214/agent-control-plane";
const ticketsPath = fileURLToPath(new URL("../docs/tickets/tickets.json", import.meta.url));
const { milestones, tickets } = JSON.parse(readFileSync(ticketsPath, "utf8"));

const gh = (args, input) =>
  execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });

const api = (method, path, fields = {}) => {
  const args = ["api", "-X", method, path];
  for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
  return JSON.parse(gh(args));
};

const body = (ticket) => ticketIssueBody(ticket, tickets);

const existingMilestones = JSON.parse(gh(["api", `repos/${REPO}/milestones?state=all&per_page=100`]));
const milestoneNumber = new Map(existingMilestones.map((m) => [m.title, m.number]));

for (const m of milestones) {
  if (milestoneNumber.has(m.title)) {
    console.log(`milestone exists: ${m.title}`);
    continue;
  }
  const created = api("POST", `repos/${REPO}/milestones`, {
    title: m.title,
    description: m.description,
  });
  milestoneNumber.set(m.title, created.number);
  console.log(`milestone created: ${m.title} (#${created.number})`);
}

const existingIssues = JSON.parse(
  gh(["api", `repos/${REPO}/issues?state=all&per_page=100`, "--paginate"]),
);
const byMarker = new Map();
for (const issue of existingIssues) {
  const found = /<!-- acp-ticket:(T\d+) -->/.exec(issue.body ?? "");
  if (found) byMarker.set(found[1], issue.number);
}

for (const ticket of tickets) {
  const milestone = milestones.find((m) => m.key === ticket.milestone);
  const number = milestoneNumber.get(milestone.title);
  const title = `[${ticket.id}] ${ticket.title}`;
  const existing = byMarker.get(ticket.id);

  if (existing) {
    execFileSync("gh", [
      "api", "-X", "PATCH", `repos/${REPO}/issues/${existing}`,
      "-f", `title=${title}`,
      "-f", `body=${body(ticket)}`,
      "-F", `milestone=${number}`,
    ], { encoding: "utf8" });
    console.log(`issue updated: #${existing} ${title}`);
  } else {
    const created = JSON.parse(
      execFileSync("gh", [
        "api", "-X", "POST", `repos/${REPO}/issues`,
        "-f", `title=${title}`,
        "-f", `body=${body(ticket)}`,
        "-F", `milestone=${number}`,
      ], { encoding: "utf8" }),
    );
    console.log(`issue created: #${created.number} ${title}`);
  }
}
