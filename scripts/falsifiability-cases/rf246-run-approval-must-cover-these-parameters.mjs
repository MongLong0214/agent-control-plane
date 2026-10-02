/**
 * #246 — Without it an approval the owner gave for a private repository, or for fewer operations, authorises this plan's writes.
 */
const rf246RunApprovalMustCoverTheseParameters = {
  id: "rf246-run-approval-must-cover-these-parameters",
  what: "the owner's approval must name exactly this owner, visibility, PLAN digest and operation set",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (receipt.parameterDigest !== expected) {\n",
  replace: "    if (receipt.parameterDigest !== receipt.parameterDigest) {\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf246RunApprovalMustCoverTheseParameters;
