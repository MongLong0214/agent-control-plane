/**
 * PR #1043 review round 3, RF1043-08 — Without it a declined or unadmitted approval reaches production and activation.
 */
const rf1043RunApprovalPrecedesEveryActivation = {
  id: "rf1043-run-approval-precedes-every-activation",
  what: "the owner's approval is admitted before the runner activates anything, a stored result included",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (!approval.allowed) return atStage(approval as Decision<ACPBootstrapActivationResult>, \"approval\");\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf1043RunApprovalPrecedesEveryActivation;
