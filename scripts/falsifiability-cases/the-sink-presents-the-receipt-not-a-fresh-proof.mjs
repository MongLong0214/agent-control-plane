/**
 * #1044 ACP-1044-01. The sink used to build the generation proof itself, at processing time, and
 * so stamped a frame that waited across a rotation with the generation it was processed under. It
 * now presents the subscriber's receipt. The mutation restores the processing-time proof.
 */
const theSinkPresentsTheReceiptNotAFreshProof = {
  id: "the-sink-presents-the-receipt-not-a-fresh-proof",
  what: "the sink presents the frame's receipt as the peer proof and never builds one",
  file: "src/daemon/agentcpd.ts",
  find: "  const peer = ingress.observePeer(input).allowed ? request.receipt : null;\n",
  replace: "  const observedPeer = ingress.observePeer(input);\n  const peer = observedPeer.allowed ? observedPeer.value : null;\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses a frame that waited in the subscriber's queue while the CTO was taken over, with zero writes",
  ],
};

export default theSinkPresentsTheReceiptNotAFreshProof;
