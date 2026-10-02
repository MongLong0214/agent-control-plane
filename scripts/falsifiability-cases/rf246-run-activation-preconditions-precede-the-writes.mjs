/**
 * #246 — Without it an incomplete handoff or an unreviewed run is found only by activation, after the repository already exists.
 */
const rf246RunActivationPreconditionsPrecedeTheWrites = {
  id: "rf246-run-activation-preconditions-precede-the-writes",
  what: "the activation preconditions a factory result cannot change are checked before any GitHub call",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "    if (!ready.allowed) return atStage(ready as Decision<ACPBootstrapActivationResult>, \"precondition\");\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf246RunActivationPreconditionsPrecedeTheWrites;
