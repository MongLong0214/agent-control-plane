/**
 * #954. A pending role whose need is already on the ledger drops out of the reconcile loop's
 * restoration candidates. Without the filter every one-minute tick runs `restore()` again, which
 * re-derives the same stop through two coverage evaluations — a full provider probe round each —
 * for as long as the role waits on a claim, and the measured wait was five days.
 *
 * The mutant keeps the pending list and drops only the recorded-need filter. The killing test
 * counts capacity refreshes across two waiting ticks against a control deployment with nothing
 * pending, and asserts each waiting tick reports no fresh deferral.
 */
const aRecordedRestorationNeedDoesNotRerunRestore = {
  id: "a-recorded-restoration-need-does-not-rerun-restore",
  what: "a pending role whose need is already recorded does not trigger another restoration pass",
  file: "src/daemon/daemon.ts",
  find: "        ...plan.restorationPending.filter((roleKey) => !this.cp.continuity.restorationNeedRecorded(roleKey)),\n",
  replace: "        ...plan.restorationPending,\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::records the pending need once, and then costs no more than a tick with nothing pending",
  ],
};

export default aRecordedRestorationNeedDoesNotRerunRestore;
