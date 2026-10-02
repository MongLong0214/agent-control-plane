/**
 * #246 — Without it `POST user/repos` creates the repository under whoever is authenticated, whatever owner the plan named.
 */
const rf246ThePortNeverCreatesUnderAnotherUser = {
  id: "rf246-the-port-never-creates-under-another-user",
  what: "the production port refuses to create a repository under a user account it is not authenticated as",
  file: "src/bootstrap/github-write-port.ts",
  find: "        if (login === null ? true : !sameGitHubName(login, target.owner)) {\n",
  replace: "        if (false && (login === null ? true : !sameGitHubName(login, target.owner))) {\n",
  killedBy: ["tests/unit/github-write-port.test.ts"],
};

export default rf246ThePortNeverCreatesUnderAnotherUser;
