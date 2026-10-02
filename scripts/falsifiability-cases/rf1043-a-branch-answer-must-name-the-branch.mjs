/**
 * PR #1043 review, RF1043-04 — Without it a readback of another branch is receipted as the branch asked about.
 */
const rf1043ABranchAnswerMustNameTheBranch = {
  id: "rf1043-a-branch-answer-must-name-the-branch",
  what: "a branch answer describing a different branch than the one asked about is refused",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    observedName === branch\n",
  replace: "    observedName === observedName\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ABranchAnswerMustNameTheBranch;
