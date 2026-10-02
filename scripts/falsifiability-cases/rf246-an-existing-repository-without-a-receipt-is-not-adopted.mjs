/**
 * #246 — Without it the producer calls create on a name someone else holds; with a port that treated the 422 as success it would receipt their repository as ours.
 */
const rf246AnExistingRepositoryWithoutAReceiptIsNotAdopted = {
  id: "rf246-an-existing-repository-without-a-receipt-is-not-adopted",
  what: "a same-named repository with no receipt from this bootstrap operation is a wrong target, never adopted",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    if (observed.value !== null) {\n      return stop(\n        ReasonCode.RESOURCE_COLLISION,\n        \"WRONG_TARGET\",\n",
  replace: "    if (false && observed.value !== null) {\n      return stop(\n        ReasonCode.RESOURCE_COLLISION,\n        \"WRONG_TARGET\",\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AnExistingRepositoryWithoutAReceiptIsNotAdopted;
