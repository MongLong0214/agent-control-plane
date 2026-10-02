/**
 * PR #1043 review round 2, RF1043-02 — Without it a checkout left mid-write is removed as if GitHub held everything it does.
 */
const rf1043AnUnreceiptedOperationUnsettlesTheCheckout = {
  id: "rf1043-an-unreceipted-operation-unsettles-the-checkout",
  what: "a leftover checkout is settled only when every planned operation is receipted",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "  if (github.execution.operations.some((operation) => !ledger.value.receipts.has(operation.operationId))) return false;\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043AnUnreceiptedOperationUnsettlesTheCheckout;
