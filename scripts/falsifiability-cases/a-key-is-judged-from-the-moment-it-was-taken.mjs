/**
 * #1044 round 3, the review's ACP-1044-03. Key history, not runtime history: a runtime that served an
 * earlier generation with no identity and took its first key only later holds a key no earlier
 * generation used. The mutation asks about every moment, including those before the key was taken,
 * and the first-ever key is refused as reused.
 */
const aKeyIsJudgedFromTheMomentItWasTaken = {
  id: "a-key-is-judged-from-the-moment-it-was-taken",
  what: "a runtime's service before it took its key does not make the key reused",
  file: "src/daemon/agentcpd.ts",
  find: "    if (record.event_id > tookIdentityAt && servingAnEarlierGenerationHere()) return true;\n",
  replace: "    if (true && servingAnEarlierGenerationHere()) return true;\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::admits a first-ever key on a runtime that served an earlier generation with no identity, and refuses it once a later generation reuses it",
  ],
};

export default aKeyIsJudgedFromTheMomentItWasTaken;
