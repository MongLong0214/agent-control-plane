/**
 * R1041-03: a settlement the callback held but did not use must not outlive the reconcile that
 * issued it, or it settles a claim later with nobody checking the reply half.
 */
const anIngressSettlementIsSpentWithItsReconcile = {
  id: "an-ingress-settlement-is-spent-with-its-reconcile",
  what: "a settlement captured from a callback settles nothing afterwards",
  file: "src/conversation/turn-coordinator.ts",
  find: "      withdrawIngressReceiptSettlement(settlement);",
  replace: "      void settlement;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::spends the settlement: one captured from the callback settles nothing afterwards",
  ],
};

export default anIngressSettlementIsSpentWithItsReconcile;
