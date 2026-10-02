/**
 * #1044. A runtime bound again in a new CEO generation keeps the key it carried in the earlier one,
 * and an event it signed then verifies exactly like one it signs now. The mutation stops asking
 * whether this runtime carried the identity while serving an earlier generation.
 */
const aPeerRuntimeFromAnEarlierGenerationIsAmbiguous = {
  id: "a-peer-runtime-from-an-earlier-generation-is-ambiguous",
  what: "a CEO identity its runtime carried in an earlier CEO generation is not this generation's alone",
  file: "src/daemon/agentcpd.ts",
  find: "        identityUsedInAnEarlierCeoGeneration(cp, ceo.sessionId, channelIdentity, ceo.bindingGeneration));\n",
  replace: "        false);\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses the CEO's events when its runtime is bound again in a new CEO generation",
  ],
};

export default aPeerRuntimeFromAnEarlierGenerationIsAmbiguous;
