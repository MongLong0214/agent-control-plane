/**
 * Timestamp orderings that do not yet name a tiebreaker.
 *
 * These are NOT assessed as safe. Each one returns ties in whatever order the query planner
 * chooses, and the four sites #858 was filed about all took the first row as "the oldest" and
 * handed its identity to a person -- two doctor findings and a migration refusal message. Which
 * row got named was decided by an index choice, not by the query.
 *
 * They are listed so the census can pass on today's tree while refusing the following copy, which
 * is the part that failed here: four sites shared one definition of "still outstanding" and a
 * comment saying so, while the ordering beside it was copied four times and diverged in silence.
 *
 * Keyed by path:line with the query text beside it. The census refuses an entry whose text no
 * longer matches, because a line that moved would otherwise excuse whatever ordering now sits
 * there -- the allow-list-keyed-by-line failure this repository has already paid for once.
 *
 * Remove an entry by giving its ordering a second term. The shape the four fixed sites use is
 * received_at then channel then nonce, which is total because (channel, nonce) is
 * inbound_messages' primary key. Presence of a second term is not the same as uniqueness, and the
 * census says so.
 *
 * sol-simplify: the backlog stays visible; remove entries as the orderings are made total (#858).
 */
export const PARTIAL_TIMESTAMP_ORDERINGS = new Map([
  ["src/conversation/turn-coordinator.ts:1169", "ORDER BY claimed_at ASC"],
  ["src/conversation/turn-coordinator.ts:1757", "ORDER BY claimed_at ASC"],
  ["src/cto/cto-lifecycle.ts:783", "ORDER BY created_at DESC"],
  ["src/daemon/agentcpd.ts:1792", "ORDER BY created_at"],
  ["src/github/github-kernel.ts:3419", "ORDER BY created_at DESC"],
  ["src/github/github-kernel.ts:3845", "ORDER BY created_at"],
  ["src/outbox/outbox.ts:434", "ORDER BY o.created_at"],
  ["src/outbox/outbox.ts:502", "ORDER BY o.created_at"],
  ["src/outbox/outbox.ts:533", "ORDER BY o.created_at"],
  ["src/outbox/outbox.ts:1098", "ORDER BY created_at"],
  ["src/outbox/outbox.ts:1183", "ORDER BY created_at"],
  ["src/registry/project-registry.ts:228", "ORDER BY created_at"],
  ["src/registry/repository-registry.ts:409", "ORDER BY created_at"],
  ["src/registry/repository-registry.ts:417", "ORDER BY created_at"],
  ["src/run/run-engine.ts:1045", "ORDER BY created_at"],
  ["src/session/binding-registry.ts:773", "ORDER BY created_at"],
  ["src/session/binding-registry.ts:781", "ORDER BY created_at"],
  ["src/session/session-registry.ts:387", "ORDER BY created_at"],
  ["src/session/session-registry.ts:390", "ORDER BY created_at"],
  ["src/session/session-registry.ts:397", "ORDER BY created_at"],
]);
