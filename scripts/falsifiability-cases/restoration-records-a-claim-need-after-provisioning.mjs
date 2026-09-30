/**
 * #954, review A1015-1. A bound role's restoration probe can invalidate the coverage plan that
 * preceded it. An owed role later in that plan must not record a claim need from the stale reading:
 * the row is written once per revocation, so a later recovery cannot correct its date.
 *
 * The mutant restores the top-of-method plan as the source of owed-role needs. The named test
 * makes CTO provisioning discover that Claude is down, then checks that a second, revoked CTO is
 * absent from both the claim-need ledger and `deferred` until Claude really recovers.
 */
const restorationRecordsAClaimNeedAfterProvisioning = {
  id: "restoration-records-a-claim-need-after-provisioning",
  what: "restoration records owed-role claim needs from coverage after its own provisioning probes",
  file: "src/continuity/continuity-kernel.ts",
  find:
    "    for (const assignment of this.claimNeedsFromCurrentCoverage()) {\n" +
    "      deferred.push({ roleKey: assignment.roleKey, reasonCode: ReasonCode.BINDING_REVOKED });\n",
  replace:
    "    for (const assignment of plan.restorationPending.flatMap((roleKey) => {\n" +
    "      const provider = plan.assignments.find((candidate) => candidate.roleKey === roleKey)?.provider;\n" +
    "      return provider ? [{ roleKey, provider }] : [];\n" +
    "    })) {\n" +
    "      deferred.push({ roleKey: assignment.roleKey, reasonCode: ReasonCode.BINDING_REVOKED });\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::restore records a claim need only after its own provisioning reads capacity",
  ],
};

export default restorationRecordsAClaimNeedAfterProvisioning;
