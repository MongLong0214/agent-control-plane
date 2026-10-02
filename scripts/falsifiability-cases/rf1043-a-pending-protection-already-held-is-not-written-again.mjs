/**
 * PR #1043 review, RF1043-02 — Without it a protection whose read-back was lost is written a second time on retry.
 */
const rf1043APendingProtectionAlreadyHeldIsNotWrittenAgain = {
  id: "rf1043-a-pending-protection-already-held-is-not-written-again",
  what: "a pending branch protection GitHub already holds is adopted, not written again",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (current.value === null ? false : sameProtection(current.value, desired)) {\n",
  replace: "      if (current.value === null ? false : false) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043APendingProtectionAlreadyHeldIsNotWrittenAgain;
