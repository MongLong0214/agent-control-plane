/**
 * The GitHub issue body `scripts/sync-issues.mjs` projects a ticket of `docs/tickets/tickets.json` onto.
 *
 * Its own module so a test can render a ticket without the script's GitHub calls. A ticket's optional
 * `amendment` is a dated correction to its `acceptance`, rendered as a labelled note right after it;
 * a ticket without one renders exactly as it did before the field existed.
 */

const marker = (id) => `<!-- acp-ticket:${id} -->`;

export const ticketIssueBody = (ticket, tickets) => {
  const titleOf = (id) => tickets.find((t) => t.id === id)?.title ?? "(unknown)";
  const deps = ticket.deps.length
    ? ticket.deps.map((d) => `\`${d}\` ${titleOf(d)}`).join("\n- ")
    : "none — this ticket is a DAG root";
  const blocks = tickets.filter((t) => t.deps.includes(ticket.id));
  return [
    marker(ticket.id),
    `**Milestone:** ${ticket.milestone}`,
    "",
    "### Depends on",
    `- ${deps}`,
    "",
    "### Blocks",
    blocks.length ? blocks.map((t) => `- \`${t.id}\` ${t.title}`).join("\n") : "- nothing",
    "",
    "### PRD requirements",
    ticket.requirements.length ? ticket.requirements.map((r) => `- ${r}`).join("\n") : "- (supporting)",
    "",
    "### Scenarios",
    ticket.scenarios.length ? ticket.scenarios.map((s) => `- ${s}`).join("\n") : "- (covered indirectly)",
    "",
    "### Acceptance",
    ticket.acceptance,
    ...(ticket.amendment === undefined ? [] : ["", `> **Amendment.** ${ticket.amendment}`]),
  ].join("\n");
};
