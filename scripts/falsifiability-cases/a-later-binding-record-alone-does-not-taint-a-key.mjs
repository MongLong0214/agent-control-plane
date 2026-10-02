/**
 * #1044 round 3. A binding record after the key was taken matters only if the state in force then
 * was an earlier generation on this runtime. The mutation treats any later record as taint, and a
 * fresh key a new runtime took before it was bound as the CEO is refused.
 */
const aLaterBindingRecordAloneDoesNotTaintAKey = {
  id: "a-later-binding-record-alone-does-not-taint-a-key",
  what: "a binding record after a key was taken taints it only when an earlier generation then ran here",
  file: "src/daemon/agentcpd.ts",
  find: "    if (record.event_id > tookIdentityAt && servingAnEarlierGenerationHere()) return true;\n",
  replace: "    if (record.event_id > tookIdentityAt) return true;\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::admits a fresh key that a new runtime took before it was bound as the CEO",
  ],
};

export default aLaterBindingRecordAloneDoesNotTaintAKey;
