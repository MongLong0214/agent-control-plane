/**
 * #246 — Without it a plan with no default-branch operation reports the plan's branch as verified while GitHub reports another, or none.
 */
const rf246TheReportedDefaultBranchIsTheOneGithubReports = {
  id: "rf246-the-reported-default-branch-is-the-one-github-reports",
  what: "the result reports a default branch only after GitHub reports that same branch",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "  if (final.value.defaultBranch !== input.defaultBranch) {\n",
  replace: "  if (false && final.value.defaultBranch !== input.defaultBranch) {\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246TheReportedDefaultBranchIsTheOneGithubReports;
