/**
 * #246 — Without it a forged or stale ledger line — a receipt or a pending write — is accepted, and the resume proceeds as if the ledger were this plan's own.
 */
const rf246ALedgerReceiptOutsideThePlanIsRefused = {
  id: "rf246-a-ledger-receipt-outside-the-plan-is-refused",
  what: "a GitHub receipt ledger that records an operation the plan does not contain is refused",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    if (operation === undefined) return notInPlan();\n",
  replace: "    if (operation === undefined) return allow(ReasonCode.OK, undefined);\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246ALedgerReceiptOutsideThePlanIsRefused;
