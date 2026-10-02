/**
 * #246 — Without it a forged or stale ledger line is silently dropped and the resume proceeds as if the ledger were this plan's own.
 */
const rf246ALedgerReceiptOutsideThePlanIsRefused = {
  id: "rf246-a-ledger-receipt-outside-the-plan-is-refused",
  what: "a GitHub receipt ledger that receipts an operation the plan does not contain is refused",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    if (planned === undefined) return notInPlan();\n",
  replace: "    if (planned === undefined) continue;\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246ALedgerReceiptOutsideThePlanIsRefused;
