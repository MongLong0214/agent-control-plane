/**
 * #627, and the same lesson #633/#651 landed on the Telegram sentences: a turn that reached the
 * CEO and did not come back is an outcome nobody established, not a failed one.
 *
 * `CeoConversationPort.attempt` reports which side of `createMessage` the outcome fell on. When
 * contact was made and no answer returned — a timeout, a dropped connection, an error from the
 * peer — the CEO may still be writing into the canonical transcript. Recording `repliedAt` there
 * would assert that ACP handed the owner a reply for a turn whose result it never saw, and the
 * `unresolvedTurns` surface that is supposed to name it would go quiet.
 *
 * `closes = true` is that assertion. It is the more tempting mutation of the two on this line,
 * because it makes every turn look tidy: no outstanding claims, no rows for anyone to resolve.
 *
 * Its opposite is guarded by `buzz-turn-nobody-was-asked-is-closed`, which shares this anchor.
 * Two rows on one line, deliberately: the line encodes a rule with two directions and each
 * direction fails differently — one hides a turn that may still be running, the other strands a
 * turn that provably never started.
 *
 * A row on a path being built, not on a defect that shipped — see
 * `buzz-event-not-addressed-to-the-ceo-is-not-a-turn` for why that distinction lives in prose.
 */
const buzzTurnReachedWithoutAnAnswerStaysUnresolved = {
  id: "buzz-turn-reached-without-an-answer-stays-unresolved",
  what: "a Buzz turn that reached the CEO without an answer is left unresolved, not marked replied",
  file: "src/ingress/buzz-message.ts",
  find: "  const closes = delivered.reachedCeo ? answered : !answered;\n",
  replace: "  const closes = true;\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::leaves the claim outstanding when the turn reached the CEO and no answer came back",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzTurnReachedWithoutAnAnswerStaysUnresolved;
