/**
 * #674. The relation is judged against the registry as it is now, not against the role key the
 * caller was handed.
 *
 * `senderRoleFor` deliberately runs early — before `guard.admit` spends the replay slot and before
 * the `p` tag is resolved, so an identity this daemon has granted nothing cannot cause either.
 * That ordering creates a window: between the two answers the sender's assignment can be revoked.
 * Re-reading the binding here is what closes it, and the cheap implementation that trusts the key
 * it was given passes every other row in this file.
 *
 * Mutating the re-read to accept an absent binding restores that implementation. The killing test
 * derives the role, revokes the assignment, and then asks for the relation — the sequence the
 * ordering actually produces, rather than a hand-built null.
 */
const aRevokedSenderHoldsNoRelation = {
  id: "a-revoked-sender-holds-no-relation",
  what: "a sender whose assignment was revoked after its role was derived holds no relation",
  file: "src/daemon/agentcpd.ts",
  find: "      const sender = currentBindingFor(senderRoleKey);\n      if (sender === null) {\n",
  replace: "      const sender = currentBindingFor(senderRoleKey);\n      if (false) {\n",
  killedBy: [
    "tests/unit/buzz-collaboration-authority.test.ts::refuses a sender whose assignment was revoked after its role was derived",
  ],
};

export default aRevokedSenderHoldsNoRelation;
