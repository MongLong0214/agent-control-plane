/**
 * PR #1043 review, RF1043-02 — Without it a repository GitHub created and that was then deleted is created again under the same name on retry.
 */
const rf1043ACreateRecordsGithubSAnswer = {
  id: "rf1043-a-create-records-github-s-answer",
  what: "a create records the node id GitHub's response named before it reads the repository back",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    begin({ ...intent, respondedNodeId: created.value.nodeId });\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ACreateRecordsGithubSAnswer;
