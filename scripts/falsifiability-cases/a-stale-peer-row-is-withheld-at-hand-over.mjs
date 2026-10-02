/**
 * #1044 ACP-1044-02. A peer message admitted under one CEO generation is not handed over under the
 * next, and the refusal is decided before the hand-over writes anything. The mutation admits every
 * peer row, and the old generation's text is handed over with PENDING -> SENT.
 */
const aStalePeerRowIsWithheldAtHandOver = {
  id: "a-stale-peer-row-is-withheld-at-hand-over",
  what: "a peer message whose admission proof is no longer current is withheld at hand-over",
  file: "src/daemon/agentcpd.ts",
  find: "            peerProofIsCurrent(admittedPeerSource(cp, candidate.payload), ceo, holder, ctoChannel),\n",
  replace: "            peerProofIsCurrent(admittedPeerSource(cp, candidate.payload), ceo, holder, ctoChannel) || true,\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::withholds a queued peer message from its CTO after the CEO rotates, writing nothing, and lets the holder reject it",
  ],
};

export default aStalePeerRowIsWithheldAtHandOver;
