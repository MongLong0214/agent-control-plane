/**
 * PR #1043 review, RF1043-02 — Without it a branch someone else pushed while this operation's push was pending is adopted as its push.
 */
const rf1043APendingPushIsAdoptedOnlyAtItsOwnCommit = {
  id: "rf1043-a-pending-push-is-adopted-only-at-its-own-commit",
  what: "a branch found under a pending push is adopted only at the commit that push recorded",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (recordedHead !== observed.value.headSha) {\n",
  replace: "      if (recordedHead === null) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043APendingPushIsAdoptedOnlyAtItsOwnCommit;
