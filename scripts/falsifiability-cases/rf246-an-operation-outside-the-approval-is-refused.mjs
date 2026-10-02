/**
 * #246 — Without it the producer performs a write nobody approved, and activation later finds a receipt with no planned operation behind it.
 */
const rf246AnOperationOutsideTheApprovalIsRefused = {
  id: "rf246-an-operation-outside-the-approval-is-refused",
  what: "a planned GitHub operation the owner's approval does not cover is refused before any GitHub call",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    if (approved === undefined) return notInPlan(\"no approved operation has this id\");\n",
  replace: "    if (approved === undefined) continue;\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AnOperationOutsideTheApprovalIsRefused;
