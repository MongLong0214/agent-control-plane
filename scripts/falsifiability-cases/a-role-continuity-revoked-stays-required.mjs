/**
 * #954. A role continuity revoked for want of coverage stays a required role until something binds
 * it again. Without that, the role leaves the plan on the tick that revoked it — `ProjectRegistry`
 * derives a project's activity from its bound-CTO count, so the revocation erases the only evidence
 * the project wanted a CTO — and coverage then reports itself whole over a role it stopped counting.
 *
 * The mutant keeps the owed-binding reader and every other requirement source, and feeds the loop
 * that re-admits owed roles nothing. The killing test brings coverage back after the revocation and
 * asserts the plan still staffs the revoked role and does not read FULL_COVERAGE.
 */
const aRoleContinuityRevokedStaysRequired = {
  id: "a-role-continuity-revoked-stays-required",
  what: "a role continuity revoked for want of coverage stays in the required roles while nobody holds it",
  file: "src/continuity/continuity-kernel.ts",
  find: "    for (const owed of this.continuityOwedBindings()) {\n",
  replace: "    for (const owed of this.continuityOwedBindings().slice(0, 0)) {\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::does not report coverage whole while the role it revoked is unbound",
  ],
};

export default aRoleContinuityRevokedStaysRequired;
