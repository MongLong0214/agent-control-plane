/**
 * #627, the composition half of `a-buzz-message-from-a-non-owner-reaches-nobody`.
 *
 * `main` opens both Buzz sockets from one relay credential, and for one commit it handed that
 * credential's `allowedActors` to the message half as well. That list is every ACTIVE Buzz
 * identity the deployment talks to; using it as the owner set is what made an ACTIVE non-owner
 * able to speak to the owner's CEO. The owner set comes from `owner-identities` instead, and an
 * absent `buzz:` line leaves the message socket closed rather than falling back to the relay's.
 *
 * The mutation is the fallback as it shipped, not a deletion: it compiles, the binding socket
 * still opens, and the message socket still opens too — which is the whole failure. A row on
 * the class-level check alone would survive it, because the class would be handed a non-empty
 * owner set and refuse nobody.
 */
const buzzMessageOwnersAreNotTheRelayAllowlist = {
  id: "buzz-message-owners-are-not-the-relay-allowlist",
  what: "the Buzz message path's owner set comes from owner-identities, not from the relay allowlist",
  file: "src/daemon/agentcpd.ts",
  find: "configuredBuzzMessageOwnerActors(config.ownerIdentities ?? [])",
  replace: "buzzActorIngressPolicy.allowedActors",
  killedBy: [
    "tests/unit/daemon-startup.test.ts::leaves the message socket closed when the relay credential names no declared owner",
  ],
};

export default buzzMessageOwnersAreNotTheRelayAllowlist;
