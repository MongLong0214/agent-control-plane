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
 * Mutating this to `if (false)` restores exactly the shipped defect — the surviving checks
 * (signature, recipient, nonce, guard allowlist) all pass for that actor, which is why the test
 * that kills this row sends the *same* envelope twice, once as the non-owner and once as the
 * owner.
 */
const aBuzzMessageFromANonOwnerReachesNobody = {
  id: "a-buzz-message-from-a-non-owner-reaches-nobody",
  what: "a Buzz message from an allowlisted non-owner is not delivered to the CEO",
  file: "src/ingress/buzz-message.ts",
  find: "    if (!this.#ownerActors.has(input.actor.trim())) {\n",
  replace: "    if (false) {\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::refuses an ACTIVE non-owner's otherwise valid CEO envelope, and still delivers the owner's identical one",
  ],
};

export default aBuzzMessageFromANonOwnerReachesNobody;
