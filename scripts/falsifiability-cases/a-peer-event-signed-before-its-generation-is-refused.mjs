/**
 * #1038. A Buzz channel identity can be reused across CEO generations, and an event the previous
 * generation signed still verifies under the same key. Its signed `created_at` is the one fact
 * that places it, and this operand is the lower edge of the current generation's window.
 *
 * Removed, a relay's redelivery of a generation-1 event after a same-key rotation is bound fresh to
 * generation 2 at receipt and admitted. The killing row signs during generation 1, rotates onto the
 * same key, redelivers through the daemon's own subscriber, and requires the refusal with zero
 * writes.
 */
const aPeerEventSignedBeforeItsGenerationIsRefused = {
  id: "a-peer-event-signed-before-its-generation-is-refused",
  what: "a CEO-authored event signed before the current CEO generation began is refused",
  file: "src/ingress/buzz-message.ts",
  find: "      signedAt * 1000 < startedAtMs ||\n",
  replace: "",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses an event signed before a same-key rotation with zero writes, even when it is re-bound at delivery",
  ],
};

export default aPeerEventSignedBeforeItsGenerationIsRefused;
