/**
 * PR #1043 review, RF1043-02 — Without it a result produced but not stored sends the retry back to the producer, which refuses its own checkout.
 */
const rf1043RunAKeptResultIsRebuiltNotReproduced = {
  id: "rf1043-run-a-kept-result-is-rebuilt-not-reproduced",
  what: "a result the producer kept is rebuilt and activated rather than produced again",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (kept.value !== null) {\n",
  replace: "    if (kept.value !== null && kept.value.runId !== kept.value.runId) {\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf1043RunAKeptResultIsRebuiltNotReproduced;
