/**
 * #1044 round 3. The replay asks whether *this* runtime was serving an earlier generation once it held
 * the key. Without the runtime comparison, a fresh key taken by a new runtime while generation 1 still
 * ran on another one is counted as generation 1's, and the new CEO's own mentions are refused.
 */
const aGenerationServedElsewhereDoesNotTaintAKey = {
  id: "a-generation-served-elsewhere-does-not-taint-a-key",
  what: "a generation served by another runtime does not make this runtime's key reused",
  file: "src/daemon/agentcpd.ts",
  // Anchored past `serving !== null`, which TypeScript answers (refusal-operands-unanswered.mjs).
  find: "serving.runtime === runtime && serving.generation < generation;\n",
  replace: "true && serving.generation < generation;\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::admits a fresh key that a new runtime took before it was bound as the CEO",
  ],
};

export default aGenerationServedElsewhereDoesNotTaintAKey;
