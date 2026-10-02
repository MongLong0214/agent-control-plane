/**
 * PR #1043 review round 2, RF1043-06 — Without it a replacement repository carrying the lost create's public description marker is adopted and written to.
 */
const rf1043ALostCreateWithoutARecordedIdentityIsNotAdopted = {
  id: "rf1043-a-lost-create-without-a-recorded-identity-is-not-adopted",
  what: "a create whose response was never recorded leaves the repository at the name unadopted and the outcome reported as indeterminate",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (pendingWrite.respondedNodeId === null) {\n",
  replace: "      if (pendingWrite.respondedNodeId !== pendingWrite.respondedNodeId) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ALostCreateWithoutARecordedIdentityIsNotAdopted;
