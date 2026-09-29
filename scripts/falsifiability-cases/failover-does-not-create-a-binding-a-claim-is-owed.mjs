/**
 * #954, review R1015-1. `failover()` is public, and once coverage returns the plan staffs a role
 * continuity revoked. With no active binding `switchTo` reads the unmatched attestation as a
 * replacement and inserts a fresh assignment, so a direct call would create by failover the binding
 * that only a claim may create again.
 *
 * The mutant removes the guard. The killing test revokes the role for want of coverage, lets
 * coverage return, attaches ports that let provisioning succeed (so a refusal is the guard's and
 * not the harness's), calls `failover()` directly, and asserts the refusal and that the role's
 * assignment rows and live sessions are unchanged.
 */
const failoverDoesNotCreateABindingAClaimIsOwed = {
  id: "failover-does-not-create-a-binding-a-claim-is-owed",
  what: "failover refuses a role continuity revoked instead of writing the assignment row a claim creates",
  file: "src/continuity/continuity-kernel.ts",
  find:
    "    if (expected === null && this.continuityOwesBinding(roleKey)) {\n" +
    "      return deny(ReasonCode.BINDING_REVOKED, \"continuity revoked this role; only a claim creates its binding again\", {\n" +
    "        roleKey,\n" +
    "      });\n" +
    "    }\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::refuses a failover that would create the binding a claim is owed",
  ],
};

export default failoverDoesNotCreateABindingAClaimIsOwed;
