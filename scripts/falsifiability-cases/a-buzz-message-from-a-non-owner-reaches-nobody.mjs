/**
 * #627. The relay allowlist and owner authority are two different questions, and for one commit
 * this path answered both with the first. `startBuzzMessageIngressListener` was handed the
 * actor-binding policy, whose `allowedActors` is every ACTIVE Buzz identity the deployment
 * talks to, and `BuzzMessageIngress` had no allowlist of its own — so an ACTIVE non-owner could
 * sign a CEO-addressed envelope under the shared relay secret and get a turn as the owner.
 *
 * The owner set now comes from `owner-identities` and is checked here, before the guard, so the
 * refusal costs a nonce as well as a turn: a non-owner cannot burn the `(buzz, eventId)` slot
 * the owner's own message needs.
 *
 * The check moved when #674 added the collaboration door: `admit` now asks `#senderRoleFor`
 * which door a sender comes through, and the owner set is consulted there. The mutation inverts
 * the membership test, which hands the owner's authority to every non-owner — the shipped defect,
 * with the surviving checks (signature, recipient, nonce, guard allowlist) all passing for that
 * actor, which is why the test that kills this row sends the *same* envelope twice, once as the
 * non-owner and once as the owner.
 *
 * Inverted rather than removed, and that is forced. Returning the sentinel unconditionally makes
 * the rest of `#senderRoleFor` unreachable, and the mutant then fails `tsc` (TS2531, TS18047 in
 * `admit`) instead of failing a test — a guard the compiler refuses to let go cannot carry a row,
 * so the mutation has to keep every statement reachable while changing what the line decides.
 */
const aBuzzMessageFromANonOwnerReachesNobody = {
  id: "a-buzz-message-from-a-non-owner-reaches-nobody",
  what: "a Buzz message from an allowlisted non-owner is not delivered to the CEO",
  file: "src/ingress/buzz-message.ts",
  find: "    if (this.#ownerActors.has(actor)) return OWNER_SENDER;\n",
  replace: "    if (!this.#ownerActors.has(actor)) return OWNER_SENDER;\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::refuses an ACTIVE non-owner's otherwise valid CEO envelope, and still delivers the owner's identical one",
  ],
};

export default aBuzzMessageFromANonOwnerReachesNobody;
