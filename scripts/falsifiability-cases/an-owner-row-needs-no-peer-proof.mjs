/**
 * #1044. The hand-over fence asks for a peer proof only of a peer message. The mutation asks every
 * row for one, and an owner's message — which has none — is withheld instead of handed over.
 */
const anOwnerRowNeedsNoPeerProof = {
  id: "an-owner-row-needs-no-peer-proof",
  what: "the hand-over's peer fence leaves owner messages as they were",
  file: "src/daemon/agentcpd.ts",
  find: "            candidate.kind !== MessageKind.PEER_MESSAGE ||\n",
  replace: "            false ||\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::withholds a queued peer message from its CTO after the CEO rotates, writing nothing, and lets the holder reject it",
  ],
};

export default anOwnerRowNeedsNoPeerProof;
