/**
 * #954, review R1015-4. `restorationPending` is documented as the roles a provider can staff and
 * nobody holds, but it also held a revoked role no provider could staff yet. The doctor then told
 * an operator that role waits on a claim, not on a provider, while `restore()` rightly skipped it.
 * `uncovered` already names such a role, so it stays in the evidence.
 *
 * The mutant drops the uncovered filter. The killing test revokes the role for want of coverage,
 * leaves the provider down, and asserts the role is uncovered, not pending, and that the doctor's
 * sentence does not send the operator to a claim.
 */
const aRoleNoProviderCanStaffIsNotAwaitingAClaim = {
  id: "a-role-no-provider-can-staff-is-not-awaiting-a-claim",
  what: "a revoked role no provider can staff yet is reported as uncovered, not as waiting on a claim",
  file: "src/continuity/continuity-kernel.ts",
  find: "      .filter((role) => !uncovered.includes(role.roleKey))\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::does not send an operator to a claim for a role no provider can staff yet",
  ],
};

export default aRoleNoProviderCanStaffIsNotAwaitingAClaim;
