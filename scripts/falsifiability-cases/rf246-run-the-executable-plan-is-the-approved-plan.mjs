/**
 * #246 — Without it a plan other than the approved one is executed under the approval, and activation refuses its result only after the writes.
 */
const rf246RunTheExecutablePlanIsTheApprovedPlan = {
  id: "rf246-run-the-executable-plan-is-the-approved-plan",
  what: "the executable plan must carry the approved PLAN artifact's digest",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (executable.planDigest !== planArtifact.digest) {\n",
  replace: "    if (executable.planDigest !== executable.planDigest) {\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf246RunTheExecutablePlanIsTheApprovedPlan;
