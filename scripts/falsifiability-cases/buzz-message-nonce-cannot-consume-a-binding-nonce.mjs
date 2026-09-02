/**
 * #627. Both Buzz paths — the actor binding that has existed since §27.2, and this message
 * ingress — are the `buzz` channel, so they share one `(channel, nonce)` dedup space in
 * `inbound_messages`. The binding path takes its nonce straight from the relay; this path derives
 * one from the relay's event id. Without a namespace of its own, an event id that happened to
 * equal a binding nonce would be refused as a replay of a binding it has nothing to do with — the
 * owner's message silently dropped, with a reason code (`INGRESS_REPLAY_IGNORED`) that sends
 * whoever investigates to the wrong path entirely.
 *
 * Emptying the prefix reproduces it: the killing test binds an actor under a chosen nonce and
 * then sends a message whose event id is the same string, which is admitted today and refused as
 * a duplicate under the mutation.
 *
 * The collision is cheap to arrange and needs no attacker — the relay picks both values, and the
 * two paths were written months apart.
 *
 * A row on a path being built, not on a defect that shipped — see
 * `buzz-event-not-addressed-to-the-ceo-is-not-a-turn` for why that distinction lives in prose.
 */
const buzzMessageNonceCannotConsumeABindingNonce = {
  id: "buzz-message-nonce-cannot-consume-a-binding-nonce",
  what: "a Buzz message nonce cannot consume an actor binding's nonce on the shared channel",
  file: "src/ingress/buzz-message.ts",
  find: "export const BUZZ_MESSAGE_NONCE_PREFIX = \"buzz-message:\";\n",
  replace: "export const BUZZ_MESSAGE_NONCE_PREFIX = \"\";\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::keeps a message event id from consuming an actor binding's nonce",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzMessageNonceCannotConsumeABindingNonce;
