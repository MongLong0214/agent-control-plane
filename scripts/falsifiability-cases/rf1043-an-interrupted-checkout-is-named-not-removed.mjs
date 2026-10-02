/**
 * PR #1043 review, RF1043-02 — Without it an interrupted run's own checkout reads as a collision of unknown provenance, and the indeterminate outcome is not stated.
 */
const rf1043AnInterruptedCheckoutIsNamedNotRemoved = {
  id: "rf1043-an-interrupted-checkout-is-named-not-removed",
  what: "a leftover checkout of this same operation is refused as an interrupted run, by name",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "    if (checkoutMarkerOf(localRepoPath) === plan.bootstrapOperationId) {\n",
  replace: "    if (checkoutMarkerOf(localRepoPath) !== checkoutMarkerOf(localRepoPath)) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043AnInterruptedCheckoutIsNamedNotRemoved;
