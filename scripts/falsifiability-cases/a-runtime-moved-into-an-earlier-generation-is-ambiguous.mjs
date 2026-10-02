/**
 * #1044 round 2. A runtime an earlier CEO generation's conversation was moved onto served that
 * generation, and a key it took there was that generation's key. The replay reads move records by
 * `event_id` and by the generation each recorded, so a move and the next binding that share one clock
 * reading are still ordered. The mutation drops move records from the replay; the killing row's event
 * — signed on the moved runtime under generation 1 and rebuilt after the same-instant re-bind — is
 * then admitted.
 */
const aRuntimeMovedIntoAnEarlierGenerationIsAmbiguous = {
  id: "a-runtime-moved-into-an-earlier-generation-is-ambiguous",
  what: "a key taken on a runtime an earlier generation was moved onto is that generation's, whatever the timestamps",
  file: "src/daemon/agentcpd.ts",
  find: "        AND kind IN ('BINDING_CREATED','BINDING_SWITCHED','BINDING_RUNTIME_MOVED','BINDING_REVOKED')\n",
  replace: "        AND kind IN ('BINDING_CREATED','BINDING_SWITCHED','BINDING_REVOKED')\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses an earlier generation's event when its runtime is bound again at the very instant it was moved there",
  ],
};

export default aRuntimeMovedIntoAnEarlierGenerationIsAmbiguous;
