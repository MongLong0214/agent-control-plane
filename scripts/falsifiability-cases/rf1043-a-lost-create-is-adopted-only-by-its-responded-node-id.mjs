/**
 * PR #1043 review, RF1043-02 — Without it a repository deleted and recreated under the name after GitHub answered the create is adopted as ours.
 */
const rf1043ALostCreateIsAdoptedOnlyByItsRespondedNodeId = {
  id: "rf1043-a-lost-create-is-adopted-only-by-its-responded-node-id",
  what: "a create whose read-back was lost is adopted only when the repository has the node id the create's response named",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "const ownsByResponse = recordedNodeId === null ? false : observed.value.nodeId === recordedNodeId;",
  replace: "const ownsByResponse = recordedNodeId === null ? false : true;",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ALostCreateIsAdoptedOnlyByItsRespondedNodeId;
