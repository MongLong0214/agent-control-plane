/**
 * #246 — Without it a receipt the caller assembled itself — never admitted by ingress — authorises GitHub writes.
 */
const rf246RunTheApprovalIsConsumedThroughOwnerAuthority = {
  id: "rf246-run-the-approval-is-consumed-through-owner-authority",
  what: "an approval that has not been consumed is admitted only through OwnerAuthority, which re-reads its ingress admission",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    return this.deps.ownerAuthority.consumeApproval(receipt, candidate);\n",
  replace: "    return { allowed: true, reasonCode: ReasonCode.OK, evidence: {}, value: undefined };\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf246RunTheApprovalIsConsumedThroughOwnerAuthority;
