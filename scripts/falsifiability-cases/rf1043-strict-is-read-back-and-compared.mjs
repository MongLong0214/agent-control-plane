/**
 * PR #1043 review, RF1043-04 — Without it a non-strict check GitHub kept passes for the strict one requested.
 */
const rf1043StrictIsReadBackAndCompared = {
  id: "rf1043-strict-is-read-back-and-compared",
  what: "required status checks' `strict` takes part in the protection comparison",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      : { strict: state.requiredStatusChecks.strict, contexts: [...state.requiredStatusChecks.contexts].sort() },",
  replace: "      : { strict: true, contexts: [...state.requiredStatusChecks.contexts].sort() },",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043StrictIsReadBackAndCompared;
