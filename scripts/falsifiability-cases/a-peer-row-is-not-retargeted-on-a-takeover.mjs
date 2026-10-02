/**
 * #1044 ACP-1044-02. A queued owner's message follows its role once to a successor; a peer
 * message may not, because its proof names the session it was admitted for. The mutation lets the
 * owner rule carry it, and the successor is handed the CEO's instruction.
 */
const aPeerRowIsNotRetargetedOnATakeover = {
  id: "a-peer-row-is-not-retargeted-on-a-takeover",
  what: "a CTO takeover rejects a queued peer message instead of retargeting it",
  file: "src/outbox/outbox.ts",
  find: "          toGeneration !== fromGeneration &&\n          !IDENTITY_BOUND_KINDS.has(row.kind as MessageKind)",
  replace: "          toGeneration !== fromGeneration",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::rejects a queued peer message on a CTO takeover instead of retargeting it to the successor",
  ],
};

export default aPeerRowIsNotRetargetedOnATakeover;
