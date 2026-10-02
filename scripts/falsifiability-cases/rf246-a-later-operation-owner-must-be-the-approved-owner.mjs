/**
 * #246 — Without it a later operation aimed at another owner is refused only as a repository mismatch, which says nothing about the approval it crosses.
 */
const rf246ALaterOperationOwnerMustBeTheApprovedOwner = {
  id: "rf246-a-later-operation-owner-must-be-the-approved-owner",
  what: "every later GitHub operation must target the approved owner, not only the repository create",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    if (!sameGitHubName(parsed.owner, authority.owner)) return ownerMismatch(operation.operationId, parsed.owner);\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246ALaterOperationOwnerMustBeTheApprovedOwner;
