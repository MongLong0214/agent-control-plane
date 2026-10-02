/**
 * #1038. The generation proof. A CEO-authored event is bound to the CEO binding generation and the
 * receiving CTO session when the subscriber receives it, and admission compares that binding with
 * the registry immediately before its first write.
 *
 * Without the comparison, an envelope bound under generation 1 and dispatched after a rotation onto
 * a runtime that reuses the same key is simply re-bound to generation 2 and admitted — the event
 * is attributed to a generation that never saw it. The killing row builds the envelope with the
 * sink's own builder, rotates, dispatches, and requires a refusal with zero writes.
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
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses an event bound under the old generation and dispatched after a rotation, with zero writes",
  ],
};

export default aPeerEnvelopeBoundToAnOldGenerationIsRefused;
