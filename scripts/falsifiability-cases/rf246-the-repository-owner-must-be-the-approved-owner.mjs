/**
 * #246 — Without it the first refusal comes from a later operation, or from none at all for a plan whose only operation is the create; the test pins the refusal to the create itself.
 */
const rf246TheRepositoryOwnerMustBeTheApprovedOwner = {
  id: "rf246-the-repository-owner-must-be-the-approved-owner",
  what: "the repository a plan creates must sit under the owner the approval names",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "  if (!sameGitHubName(repository.owner, authority.owner)) return ownerMismatch(first.operationId, repository.owner);\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246TheRepositoryOwnerMustBeTheApprovedOwner;
