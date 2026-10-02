/**
 * PR #1043 review, RF1043-03 — Without it the repository is created and activation then stops at a CI gap no retry can close.
 */
const rf1043RunCiEvidenceIsRefusedBeforeWrites = {
  id: "rf1043-run-ci-evidence-is-refused-before-writes",
  what: "a manifest requiring CI evidence is refused before any GitHub call",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (manifest.ciWorkflows.length > 0) {\n",
  replace: "    if (manifest.ciWorkflows.length < 0) {\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf1043RunCiEvidenceIsRefusedBeforeWrites;
