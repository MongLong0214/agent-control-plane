/**
 * `approved` is the owner's decision, and a rejection is a decision. Nothing downstream re-reads
 * it — `OwnerAuthority.assertApproval` checks that the receipt was admitted, not what it said —
 * so this is the only place a "no" is answered as one. Without it the field is decoration and a
 * rejection releases the binding exactly as an approval would.
 */
const aRejectedOwnerDecisionDoesNotReleaseABinding = {
  id: "a-rejected-owner-decision-does-not-release-a-binding",
  what: "an owner decision of `approved: false` refuses the release",
  file: "src/daemon/dead-binding-recovery.ts",
  find: "  if (!request.approved) {\n",
  replace: "  if (false) {\n",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::refuses an owner decision that is a rejection",
  ],
};

export default aRejectedOwnerDecisionDoesNotReleaseABinding;
