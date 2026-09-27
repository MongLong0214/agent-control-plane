/**
 * #1005 - the pin that decides whether a running session may be adopted at all.
 *
 * Widening membership to "any session whose ancestry parsed" is the whole of the defect this
 * primitive exists to prevent: `deriveClaimantIdentity` proves *which* claude process is calling,
 * and nothing else in the module cares whether the deployment ever named it. With the membership
 * test gone, any live claude process that can open the socket is adopted as a CTO.
 *
 * `includes` -> a constant `true` rather than deleting the `if`: deleting it would also delete the
 * `deny` and leave `config.canonicalSessionUuids` unread, which is a different (and compile-time
 * visible) change. This mutant typechecks and runs, so a survival would be a real gap.
 */
const c = {
  id: "the-adoption-pin-is-membership-in-the-configured-set",
  what: "only a session the deployment configured as adoptable is adopted",
  file: "src/registry/canonical-self-claim.ts",
  find: "  if (!config.canonicalSessionUuids.includes(identity.sessionUuid)) {",
  replace: "  if (!config.canonicalSessionUuids.includes(identity.sessionUuid) && false) {",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 4 — only a configured canonical session may be adopted; a different, otherwise-valid session is refused, not bootstrapped",
  ],
};
export default c;
