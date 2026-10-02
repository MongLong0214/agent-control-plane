/**
 * #246 — Without it the call that follows a handoff acknowledgement produces again, and the producer refuses its own checkout as a collision.
 */
const rf246RunAProducedResultIsActivatedNotReproduced = {
  id: "rf246-run-a-produced-result-is-activated-not-reproduced",
  what: "a retained Repo Factory result is activated again rather than produced again",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (retained !== null) {\n",
  replace: "    if (retained !== null && retained.digest !== retained.digest) {\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf246RunAProducedResultIsActivatedNotReproduced;
