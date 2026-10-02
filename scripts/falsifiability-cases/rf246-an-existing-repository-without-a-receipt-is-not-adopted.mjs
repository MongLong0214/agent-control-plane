/**
 * #246, PR #1043 review RF1043-02 — Without it a repository a lost create cannot be shown to have made — another node id, or a description that is not its marker — is adopted as ours.
 */
const rf246AnExistingRepositoryWithoutAReceiptIsNotAdopted = {
  id: "rf246-an-existing-repository-without-a-receipt-is-not-adopted",
  what: "a same-named repository nothing this operation recorded identifies as its own create is a wrong target, never adopted",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (ownsByResponse === ownsByMarker) {\n",
  replace: "      if (ownsByResponse === ownsByMarker && ownsByResponse) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AnExistingRepositoryWithoutAReceiptIsNotAdopted;
