/**
 * PR #1043 review, RF1043-02 — Without it a result lost before it was stored cannot be rebuilt, and the retry is refused at its own checkout.
 */
const rf1043AProducedResultIsKeptForReconstruction = {
  id: "rf1043-a-produced-result-is-kept-for-reconstruction",
  what: "the producer keeps its result beside the ledger before returning it",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "    writeProducedResult(producedResultPath(input.workDir, plan.repositoryRole), ledgerOwner, result);\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf1043AProducedResultIsKeptForReconstruction;
