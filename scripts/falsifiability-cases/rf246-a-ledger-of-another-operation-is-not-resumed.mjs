/**
 * #246 — Without it a second bootstrap operation in the same work directory adopts the first one's writes as its own.
 */
const rf246ALedgerOfAnotherOperationIsNotResumed = {
  id: "rf246-a-ledger-of-another-operation-is-not-resumed",
  what: "a GitHub receipt ledger written for a different bootstrap operation is refused rather than resumed",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "  if (ledger.bootstrapOperationId !== owner.bootstrapOperationId) return foreign(\"bootstrap operation\");\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246ALedgerOfAnotherOperationIsNotResumed;
