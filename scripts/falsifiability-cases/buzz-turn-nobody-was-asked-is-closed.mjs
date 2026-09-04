/**
 * #627, the other direction of the resolution rule.
 *
 * When the CEO conversation port refuses *before* `createMessage` — no peer connected, a
 * superseded binding, a peer that never declared sampling — that refusal is positive evidence
 * that nothing was asked and nothing is running. The owner gets the refusal sentence, and the
 * claim has to close: `IngressGuard`'s unresolved rows are deliberately never pruned (a claim
 * needs a person, not a timer), so a claim left open for a turn that never started would sit on
 * disk forever and count against the conversation in every later reading of it.
 *
 * `closes = false` produces exactly that: a Buzz channel that accumulates permanent unresolved
 * turns for the ordinary case of asking a question while the CEO happens not to be connected.
 *
 * Its opposite is guarded by `buzz-turn-reached-without-an-answer-stays-unresolved`, which shares
 * this anchor. See that row for why one line carries two.
 *
 * A row on a path being built, not on a defect that shipped — see
 * `buzz-event-not-addressed-to-the-ceo-is-not-a-turn` for why that distinction lives in prose.
 */
const buzzTurnNobodyWasAskedIsClosed = {
  id: "buzz-turn-nobody-was-asked-is-closed",
  what: "a Buzz turn nothing was asked of is closed rather than left outstanding forever",
  file: "src/ingress/buzz-message.ts",
  find: "  const closes = delivered.reachedCeo ? answered : !answered;\n",
  replace: "  const closes = false;\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::tells the owner when no CEO peer is connected instead of starting one",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzTurnNobodyWasAskedIsClosed;
