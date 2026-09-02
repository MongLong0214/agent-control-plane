/**
 * #627. `IngressGuard.admit` verifies a signature only when the channel's policy carries a
 * secret. On a policy without one it still checks the allowlist and the nonce, and then admits —
 * so an unsigned Buzz policy is not "weaker authentication", it is *none*: anything that can
 * reach the socket and name an allowlisted pubkey speaks to the owner's CEO as the owner.
 *
 * `BuzzMessageIngress.admit` therefore refuses to run at all on such a policy rather than
 * inheriting the guard's silence, which is the same refusal `BuzzActorIngress.bindActor` makes
 * for the same reason.
 *
 * This is the class-level half of the property; the listener refuses an empty secret at
 * construction (see `buzz-message-socket-does-not-open-unsigned`). Two guards, deliberately, on
 * two different callers: the socket path cannot reach this one, and a direct caller of the class
 * cannot reach the other. Mutating either to `if (false)` leaves that caller unguarded.
 *
 * A row on a path being built, not on a defect that shipped — see
 * `buzz-event-not-addressed-to-the-ceo-is-not-a-turn` for why that distinction lives in prose.
 */
const buzzMessageOnAnUnsignedPolicyReachesNobody = {
  id: "buzz-message-on-an-unsigned-policy-reaches-nobody",
  what: "a Buzz message is not delivered at all on an unsigned ingress policy",
  file: "src/ingress/buzz-message.ts",
  find: "    if (!this.guard.requiresSignature(\"buzz\")) {\n",
  replace: "    if (false) {\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::refuses to deliver at all on an unsigned Buzz policy",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzMessageOnAnUnsignedPolicyReachesNobody;
