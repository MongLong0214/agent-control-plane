/**
 * R1041-03, round 2: matching receipt fields on a claim are not the claim being this turn's. The
 * read-back compares each member's frozen identity with the verified query before anything commits.
 */
const anIngressReadBackChecksTheClaimedTurn = {
  id: "an-ingress-read-back-checks-the-claimed-turn",
  what: "an ingress completion commits only when every settled claim belongs to the verified turn",
  file: "src/conversation/turn-coordinator.ts",
  find: "          !this.#ingressClaimBoundTo(source.channel, nonce, query) ||",
  replace: "          false ||",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-03 refuses a receipt for one turn against the claim of another, whatever the callback writes",
  ],
};

export default anIngressReadBackChecksTheClaimedTurn;
