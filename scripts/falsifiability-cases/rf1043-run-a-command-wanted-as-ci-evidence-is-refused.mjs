/**
 * PR #1043 review, RF1043-03 — Without it a local run is recorded as evidence of a kind the manifest says it is not.
 */
const rf1043RunACommandWantedAsCiEvidenceIsRefused = {
  id: "rf1043-run-a-command-wanted-as-ci-evidence-is-refused",
  what: "a manifest command required as CI evidence is refused, since the producer records a local run",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (command.evidenceMode !== \"LOCAL_COMMAND\") {\n",
  replace: "    if (command.evidenceMode !== command.evidenceMode) {\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf1043RunACommandWantedAsCiEvidenceIsRefused;
