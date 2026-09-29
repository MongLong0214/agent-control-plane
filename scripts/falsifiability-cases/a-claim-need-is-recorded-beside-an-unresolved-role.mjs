/**
 * #954, review R1015-2. The reconcile loop withholds `restore()` while any role is unresolved,
 * because that pass may move an acting owner. The record of a role waiting on a claim moves nobody,
 * and before this a sensor failing on an unrelated provider kept it off the ledger for as long as
 * that sensor stayed down.
 *
 * The mutant restores the empty `deferred` of the withheld branch. The killing test binds a second
 * role on a provider whose sensor failed, so the pass is unresolved, and asserts the revoked role's
 * `CONTINUITY_RESTORE_AWAITS_CLAIM` row is written anyway, once.
 */
const aClaimNeedIsRecordedBesideAnUnresolvedRole = {
  id: "a-claim-need-is-recorded-beside-an-unresolved-role",
  what: "a role awaiting a claim is recorded on a reconcile pass another role left unresolved",
  file: "src/daemon/daemon.ts",
  find: "        : { restored: [], deferred: this.cp.continuity.recordClaimNeeds() };\n",
  replace: "        : { restored: [], deferred: [] };\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::records the claim need while another role's reading is unresolved",
  ],
};

export default aClaimNeedIsRecordedBesideAnUnresolvedRole;
