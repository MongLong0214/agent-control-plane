/**
 * ACP-REVIEW-01. Inside the admission's transaction, a failed insert of the admission's own audit
 * row is returned as an AUDIT_WRITE_FAILED denial, and `txDecision` rolls a denial back. The
 * regression this row watches is the one that looks like a fix: noticing the failure and carrying
 * on, which commits the session, the binding and the generation bump with no row saying the claim
 * was admitted.
 *
 * The mutation keeps the denial being built and discards it, so control falls through to the
 * admission's return; it typechecks and the caught error is still read. The named verdict requires
 * a refusal and every table unchanged, and under the mutant it gets an admission and a committed
 * binding instead.
 */
const c = {
  id: "a-failed-admission-row-rolls-the-admission-back",
  what: "a canonical self-claim whose admission row cannot be written is refused and rolled back, never committed without its row",
  file: "src/registry/canonical-self-claim.ts",
  find: "        return deny(\n          ReasonCode.AUDIT_WRITE_FAILED,",
  replace: "        void deny(\n          ReasonCode.AUDIT_WRITE_FAILED,",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::an admission whose audit row cannot be written is rolled back and refused, not committed and reported as an internal error",
  ],
};
export default c;
