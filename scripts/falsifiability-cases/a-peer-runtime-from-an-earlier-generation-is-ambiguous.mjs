/**
 * #1044. The same runtime bound again in a new CEO generation keeps its key, so an event it signed
 * during the earlier generation verifies exactly like one it signs now. The mutation disables the
 * clause that sees an earlier CEO assignment on this runtime.
 */
const aPeerRuntimeFromAnEarlierGenerationIsAmbiguous = {
  id: "a-peer-runtime-from-an-earlier-generation-is-ambiguous",
  what: "a CEO runtime that served an earlier CEO generation has no exclusive identity",
  file: "src/daemon/agentcpd.ts",
  find: "                     WHERE role_key = ? AND binding_generation < ? AND session_id = ?)\n",
  replace: "                     WHERE role_key = ? AND binding_generation < ? AND session_id = ? AND 0)\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses the CEO's events when its runtime is bound again in a new CEO generation",
  ],
};

export default aPeerRuntimeFromAnEarlierGenerationIsAmbiguous;
