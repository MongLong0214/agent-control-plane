/**
 * PR #1043 review, RF1043-02 — Without it a setting whose read-back was lost is written a second time on retry.
 */
const rf1043APendingSettingAlreadyHeldIsNotWrittenAgain = {
  id: "rf1043-a-pending-setting-already-held-is-not-written-again",
  what: "a pending default-branch setting GitHub already holds is adopted, not written again",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (repository.value.defaultBranch === desired) {\n        return allow(ReasonCode.OK, {\n",
  replace: "      if (repository.value.defaultBranch !== repository.value.defaultBranch) {\n        return allow(ReasonCode.OK, {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043APendingSettingAlreadyHeldIsNotWrittenAgain;
