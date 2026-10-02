/**
 * #246 — Without it the owner's own refusal, admitted through ingress, is read as the approval it declined.
 */
const rf246RunADeclinedApprovalWritesNothing = {
  id: "rf246-run-a-declined-approval-writes-nothing",
  what: "an owner receipt that declines the write is refused before any GitHub call",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (!receipt.approved) return refuse(\"APPROVAL_DECLINED\", \"the owner declined this GitHub write\");\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf246RunADeclinedApprovalWritesNothing;
