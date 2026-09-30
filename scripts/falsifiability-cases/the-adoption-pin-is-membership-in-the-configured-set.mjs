/**
 * #1005 - the pin that decides whether a running session may be adopted at all.
 *
 * Review #1006 (round 2): the previous `what` still overclaimed — "the adoption pin, not a later
 * gate, is what decides membership" reads as if defeating the pin would let an unconfigured session
 * through, and it does not. Since #1005 the entitlement lookup a few lines further on resolves the
 * same derived UUID against the same entries and refuses an unconfigured session on its own, with
 * "the adopted session has no configured entry" — deliberate defence in depth, recorded as such at
 * that lookup, and not removed here. No test can witness the stronger claim while that later gate
 * exists, so this row does not attempt to: the pin's own refusal is "only a canonical session may
 * be adopted by this primitive", and with the pin defeated the named test's assertion on that exact
 * text fails, because the module now denies for the *other* reason and with the *other* message.
 * What is actually witnessed is narrower than "decides membership": the pin is coupled to its own
 * refusal identity, and widening it changes which of the two gates answers and what it says — not
 * whether the answer is still no.
 *
 * Deleting that later lookup so this mutation would have something stronger to witness was
 * rejected rather than taken as the fix: it would trade the property for the measurement, and
 * the seam where the two sets could stop agreeing is exactly what it exists to catch.
 *
 * `includes` -> a constant `true` rather than deleting the `if`: deleting it would also delete the
 * `deny` and leave `config.canonicalSessionUuids` unread, which is a different (and compile-time
 * visible) change. This mutant typechecks and runs, so a survival would be a real gap.
 */
const c = {
  id: "the-adoption-pin-is-membership-in-the-configured-set",
  what: "defeating the adoption pin changes which gate refuses an unconfigured session and what it says — the pin's own refusal, not that the pin (rather than the later entitlement lookup) is what ultimately decides membership",
  file: "src/registry/canonical-self-claim.ts",
  find: "  if (!config.canonicalSessionUuids.includes(identity.sessionUuid)) {",
  replace: "  if (!config.canonicalSessionUuids.includes(identity.sessionUuid) && false) {",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 4 — only a configured canonical session may be adopted; a different, otherwise-valid session is refused, not bootstrapped",
  ],
};
export default c;
