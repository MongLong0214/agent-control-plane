/**
 * PR #1043 review round 2, RF1043-02 — Without it a run that died after its last receipt and before keeping its result can never be retried.
 */
const rf1043ASettledOwnedCheckoutIsRebuilt = {
  id: "rf1043-a-settled-owned-checkout-is-rebuilt",
  what: "a leftover checkout of this operation whose ledger is settled is rebuilt from the ledger rather than refused",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "      if (await ownedCheckoutIsSettled(workDir, localRepoPath, github, ledgerOwner)) {\n",
  replace: "      if ((await ownedCheckoutIsSettled(workDir, localRepoPath, github, ledgerOwner)) && workDir !== workDir) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ASettledOwnedCheckoutIsRebuilt;
