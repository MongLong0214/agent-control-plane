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
  // Not a backlog item that will be worked down like the others. `src/db/migrations.ts` is a
  // frozen, append-only input whose exact bytes are pinned in `tests/helpers/frozen-authority.ts`
  // from a digest an authority outside this change supplied — the pin is deliberately not
  // recomputed from the file, because "a pin a run derives from its own input agrees with whatever
  // it is handed" is the defect it exists to close.
  //
  // So adding a tiebreaker here is not mine to do. I did it, and the pin caught it: the file's
  // digest moved to 7520049c… against a pinned 6d67c8f9…, and the migration test failed. Reverted.
  // The ordering is a `LIMIT 1` that picks which row is named in a v35 refusal message, so the
  // consequence of the tie is a person sent to the wrong nonce — real, and still not a reason to
  // edit a frozen input without the authority that froze it.
  ["src/db/migrations.ts:2293", "ORDER BY received_at ASC"],
  ["src/conversation/turn-coordinator.ts:1169", "ORDER BY claimed_at ASC"],
  ["src/conversation/turn-coordinator.ts:1757", "ORDER BY claimed_at ASC"],
  ["src/cto/cto-lifecycle.ts:783", "ORDER BY created_at DESC"],
  ["src/daemon/agentcpd.ts:1792", "ORDER BY created_at"],
  ["src/github/github-kernel.ts:3419", "ORDER BY created_at DESC"],
  ["src/github/github-kernel.ts:3845", "ORDER BY created_at"],
  ["src/run/run-engine.ts:1045", "ORDER BY created_at"],
]);
