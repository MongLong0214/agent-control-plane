/**
 * #1038, re-witnessed for #1044. The generation proof. A frame is bound to the CEO binding
 * generation and the receiving CTO session when it arrives at the subscriber, and admission compares
 * that receipt with the registry immediately before its first write.
 *
 * Without the comparison, a frame that waited in the subscriber's queue while the CTO was taken over
 * is admitted for the successor — the instruction is attributed to a session it was never sent to.
 * The killing row holds the queue behind another frame's admission, takes the CTO over while the
 * frame waits, and requires a refusal with zero writes.
 */
const aPeerEnvelopeBoundToAnOldGenerationIsRefused = {
  id: "a-peer-envelope-bound-to-an-old-generation-is-refused",
  what: "a peer envelope bound to a CEO generation that is no longer current is refused before any write",
  file: "src/ingress/buzz-message.ts",
  // The current binding compared with itself, rather than `if (false)`: the refusal below reads
  // `current.value`, and inside a literally unreachable block TypeScript drops the narrowing that
  // makes that read legal, so the bare form is a mutant that does not compile.
  find: "    if (!samePeerBinding(input.peer, current.value)) {\n",
  replace: "    if (!samePeerBinding(current.value, current.value)) {\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses a frame that waited in the subscriber's queue while the CTO was taken over, with zero writes",
  ],
};

export default aPeerEnvelopeBoundToAnOldGenerationIsRefused;
