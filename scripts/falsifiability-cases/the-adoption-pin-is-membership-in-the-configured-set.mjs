/**
 * #1005 - the pin that decides whether a running session may be adopted at all.
 *
 * What this row witnesses, stated no more strongly than the mutant supports (review #1006/sol
 * ACP1006-R1-04): membership is decided *here*, at the pin, and with the pin widened the refusal
 * changes. It does NOT witness that a stranger gets adopted. Since #1005 the entitlement lookup a
 * few lines further on resolves the same UUID against the same entries and refuses an unconfigured
 * session with "the adopted session has no configured entry", so the mutated module still says no —
 * the named test fails on the refusal it asserts, not on an adoption succeeding.
 *
 * That redundancy is deliberate and is recorded as such at the lookup: the two sets could stop
 * agreeing, and this is the seam where that would show. The consequence for this row is only that
 * its kill proves coupling to the pin, not that the pin is the last thing standing.
 *
 * `includes` -> a constant `true` rather than deleting the `if`: deleting it would also delete the
 * `deny` and leave `config.canonicalSessionUuids` unread, which is a different (and compile-time
 * visible) change. This mutant typechecks and runs, so a survival would be a real gap.
 */
const c = {
  id: "the-adoption-pin-is-membership-in-the-configured-set",
  what: "the adoption pin, not a later gate, is what decides membership in the configured set",
  file: "src/registry/canonical-self-claim.ts",
  find: "  if (!config.canonicalSessionUuids.includes(identity.sessionUuid)) {",
  replace: "  if (!config.canonicalSessionUuids.includes(identity.sessionUuid) && false) {",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 4 — only a configured canonical session may be adopted; a different, otherwise-valid session is refused, not bootstrapped",
  ],
};
export default c;
