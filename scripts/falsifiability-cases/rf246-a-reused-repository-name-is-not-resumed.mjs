/**
 * #246 — Without it a repository deleted and recreated by someone else under the same name is resumed as ours, and every later write lands on it.
 *
 * The mutation is a never-true self-comparison rather than `if (false && …)` or `… && false`:
 * TypeScript drops its narrowing inside a constant-false operand or branch, the mutant then fails
 * `tsc --noEmit`, and the harness refuses an uncompilable mutant as an unusable row (measured).
 */
const rf246AReusedRepositoryNameIsNotResumed = {
  id: "rf246-a-reused-repository-name-is-not-resumed",
  what: "resume is by node id: a receipted repository name now holding a different node id is refused",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (observed.value.nodeId !== prior.observed.nodeId) {\n",
  replace: "      if (observed.value.nodeId !== observed.value.nodeId) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AReusedRepositoryNameIsNotResumed;
