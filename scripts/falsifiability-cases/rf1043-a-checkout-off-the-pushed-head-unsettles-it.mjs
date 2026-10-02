/**
 * PR #1043 review round 2, RF1043-02 — Without it a checkout carrying commits GitHub does not hold is removed, and they are lost.
 */
const rf1043ACheckoutOffThePushedHeadUnsettlesIt = {
  id: "rf1043-a-checkout-off-the-pushed-head-unsettles-it",
  what: "a leftover checkout is settled only at the head the push receipt names",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "  return (await tryRevParse(localRepoPath, \"HEAD\")) === push.observed.headSha;\n",
  replace: "  return push.observed.headSha === push.observed.headSha;\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ACheckoutOffThePushedHeadUnsettlesIt;
