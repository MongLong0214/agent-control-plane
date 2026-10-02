/**
 * #246 — Without it a repository deleted and recreated by someone else under the same name is resumed as ours, and every later write lands on it.
 */
const rf246AReusedRepositoryNameIsNotResumed = {
  id: "rf246-a-reused-repository-name-is-not-resumed",
  what: "resume is by node id: a receipted repository name now holding a different node id is refused",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (observed.value.nodeId !== prior.observed.nodeId) {\n",
  replace: "      if (false && observed.value.nodeId !== prior.observed.nodeId) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AReusedRepositoryNameIsNotResumed;
