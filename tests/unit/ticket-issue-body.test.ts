import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Ticket, ticketIssueBody } from "../../scripts/lib/ticket-issue-body.mjs";

const { tickets } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../docs/tickets/tickets.json", import.meta.url)), "utf8"),
) as { tickets: Ticket[] };
const ticket = (id: string): Ticket => {
  const found = tickets.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ticket ${id}`);
  return found;
};

describe("the issue body sync-issues.mjs renders for a ticket", () => {
  it("renders T032's amendment as a labelled, dated note right after the acceptance it amends", () => {
    const t032 = ticket("T032");
    expect(t032.amendment).toMatch(/^2026-11-07: Grok support removed/);
    expect(ticketIssueBody(t032, tickets).endsWith(
      `### Acceptance\n${t032.acceptance}\n\n> **Amendment.** ${t032.amendment}`,
    )).toBe(true);
  });

  it("renders a ticket without an amendment exactly as before the field existed", () => {
    const t033 = ticket("T033");
    expect(t033.amendment).toBeUndefined();
    const body = ticketIssueBody(t033, tickets);
    expect(body).not.toContain("Amendment");
    expect(body.endsWith(`### Acceptance\n${t033.acceptance}`)).toBe(true);
    // The whole shape, pinned for a synthetic ticket so the expectation does not depend on the file.
    const root: Ticket = {
      id: "T900", milestone: "M9", title: "root", deps: [], requirements: [], scenarios: [], acceptance: "it works.",
    };
    const child: Ticket = { ...root, id: "T901", title: "child", deps: ["T900"], requirements: ["CP-001"], scenarios: ["CP-S01"] };
    expect(ticketIssueBody(root, [root, child])).toBe([
      "<!-- acp-ticket:T900 -->",
      "**Milestone:** M9",
      "",
      "### Depends on",
      "- none — this ticket is a DAG root",
      "",
      "### Blocks",
      "- `T901` child",
      "",
      "### PRD requirements",
      "- (supporting)",
      "",
      "### Scenarios",
      "- (covered indirectly)",
      "",
      "### Acceptance",
      "it works.",
    ].join("\n"));
    expect(ticketIssueBody(child, [root, child])).toBe([
      "<!-- acp-ticket:T901 -->",
      "**Milestone:** M9",
      "",
      "### Depends on",
      "- `T900` root",
      "",
      "### Blocks",
      "- nothing",
      "",
      "### PRD requirements",
      "- CP-001",
      "",
      "### Scenarios",
      "- CP-S01",
      "",
      "### Acceptance",
      "it works.",
    ].join("\n"));
  });
});
