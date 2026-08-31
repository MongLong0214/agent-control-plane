/**
 * #627. The CEO's reply command resumes the owner's own conversation, so running one message
 * twice appends the same exchange twice to a transcript the CEO then carries forward as context.
 * It cannot be unwound and the CEO cannot tell it happened — the reason `IngressGuard.claimTurn`
 * exists at all, and the reason the Telegram DIRECT handler takes a claim before it runs.
 *
 * Deleting the claim leaves the delivery working, which is why this row's mutation is worth
 * having: nonce dedup in `admit` still refuses a redelivered event, so the *visible* behaviour is
 * unchanged and only the durable record is gone. What disappears with it is the whole of what a
 * claim is for — the turn identity (`turnRequestId`, `sessionDigest`, `promptDigest`,
 * `bindingDigest`) that a later receipt is matched against (#638/#639), and the `unresolvedTurns`
 * row that says a turn's outcome was never established.
 *
 * The killing test therefore asserts on `turn_claim_json`, not on the reply. A test that only
 * checked delivery would pass against this mutation.
 *
 * A row on a path being built, not on a defect that shipped — see
 * `buzz-event-not-addressed-to-the-ceo-is-not-a-turn` for why that distinction lives in prose.
 */
const buzzTurnIsClaimedBeforeTheCeoIsAsked = {
  id: "buzz-turn-is-claimed-before-the-ceo-is-asked",
  what: "a Buzz message takes its turn claim before the CEO is asked anything",
  file: "src/ingress/buzz-message.ts",
  find:
    "  const claimed = ingress.claimTurn(admitted.value.nonce, identity);\n" +
    "  if (!claimed.allowed) return claimed as Decision<BuzzMessageAnswer>;\n",
  replace: "",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::claims the turn under the CEO generation it was answered by, and refuses the same event twice",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzTurnIsClaimedBeforeTheCeoIsAsked;
