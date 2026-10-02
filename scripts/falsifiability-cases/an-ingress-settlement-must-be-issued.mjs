/**
 * R1041-03: the guard settles a claim only from a settlement the coordinator issued after its sealed
 * port matched the receipt. Accepting the shape is accepting the caller's word.
 */
const anIngressSettlementMustBeIssued = {
  id: "an-ingress-settlement-must-be-issued",
  what: "a settlement a caller built does not settle an ingress claim",
  file: "src/ingress/ingress-guard.ts",
  find: "    const issued = redeemIngressReceiptSettlement(settlement);",
  replace: "    const issued = redeemIngressReceiptSettlement(settlement) ?? settlement;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-03 refuses a settlement shaped like the coordinator's but built by a caller",
  ],
};

export default anIngressSettlementMustBeIssued;
