/**
 * #1044 round 2. A runtime an earlier CEO generation's conversation was moved onto served that
 * generation, and an event it signed then verifies like one it signs after being bound again. The
 * clause reads the generation the move recorded; the review's reproduction tied the move and the
 * next binding to one timestamp, which a comparison of times answered as "not reused". The mutation
 * disables the clause, and the killing row's event — signed on the moved runtime under generation 1
 * and rebuilt after the same-instant re-bind — is admitted.
 */
const aRuntimeMovedIntoAnEarlierGenerationIsAmbiguous = {
  id: "a-runtime-moved-into-an-earlier-generation-is-ambiguous",
  what: "a CEO runtime an earlier generation was moved onto has no exclusive identity, whatever the timestamps",
  file: "src/daemon/agentcpd.ts",
  find: "                       AND COALESCE(json_extract(evidence_json, '$.generation'), -1) < ?) AS reused`,\n",
  replace: "                       AND COALESCE(json_extract(evidence_json, '$.generation'), -1) < ? AND 0) AS reused`,\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses an earlier generation's event when its runtime is bound again at the very instant it was moved there",
  ],
};

export default aRuntimeMovedIntoAnEarlierGenerationIsAmbiguous;
