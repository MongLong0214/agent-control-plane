/**
 * #1044. The rule that acts on the registry's answer: a reused identity refuses before the target,
 * the channel or the signed time are looked at, because none of those can say which generation
 * signed. The replacement is false at runtime and keeps the narrowing the refusal reads.
 */
const aReusedPeerIdentityIsRefused = {
  id: "a-reused-peer-identity-is-refused",
  what: "every event signed with a reused CEO channel identity is refused",
  file: "src/ingress/buzz-message.ts",
  find: "    if (ceo.channelIdentityReused) {\n",
  replace: "    if (ceo.channelIdentityReused && ceo.bindingGeneration < 0) {\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses every event signed with a reused key after a same-key rotation, and admits one from a fresh key",
  ],
};

export default aReusedPeerIdentityIsRefused;
