/**
 * #1005 - an empty configured set is an unsupplied configuration, not a deployment that has
 * chosen to adopt nothing.
 *
 * Without this operand an empty array constructs, and the failure moves: `verifyClaudeIdentity`
 * receives an empty list of admissible UUIDs, every membership test is false, and the claim socket
 * is bound and listening while no claim it can ever receive is admissible. The refusal at startup
 * is what makes that a composition error instead of a listener that silently says no.
 *
 * Measured directly before this row was written: removing the operand leaves the `isArray` half,
 * which an empty array satisfies, and one case fails.
 */
const c = {
  id: "the-adoptable-set-is-not-empty",
  what: "an empty configured adoptable set constructs nothing",
  file: "src/registry/canonical-self-claim.ts",
  find: " || canonicalSessions.length === 0",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::fails closed on an empty adoptable set, which is an unsupplied configuration and not a choice",
  ],
};
export default c;
