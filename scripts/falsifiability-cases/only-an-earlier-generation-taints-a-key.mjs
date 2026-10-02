/**
 * #1044 round 3. The current generation is the one entitled to the key; only a strictly earlier one
 * makes it reused. Without the comparison every CEO whose runtime holds its key is refused.
 */
const onlyAnEarlierGenerationTaintsAKey = {
  id: "only-an-earlier-generation-taints-a-key",
  what: "the current CEO generation does not count as an earlier one",
  file: "src/daemon/agentcpd.ts",
  // Anchored past `serving !== null`, which TypeScript answers (refusal-operands-unanswered.mjs).
  find: "serving.runtime === runtime && serving.generation < generation;\n",
  replace: "serving.runtime === runtime && true;\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::admits the current CEO's mention as one peer message bound to its generation and the receiving CTO session",
  ],
};

export default onlyAnEarlierGenerationTaintsAKey;
