/**
 * The automatic doctor refresh carries the daemon's supplemental findings.
 *
 * Only the operator's `DOCTOR_RUN` used to pass them, so a connected holder outside the qualified
 * set made an on-demand report `DEGRADED` while the next reconciliation, clean in every other
 * respect, persisted `HEALTHY` to `health.json`. Reading them inside `runSystemDoctorCheck` fixed
 * every automatic path and left the two MCP `doctor_run` doors -- which do not call it -- still
 * answering from the smaller set, so #1010 moved the set onto the `Doctor` itself: the daemon
 * registers one supplier in `start()`, once it holds the single-instance lock, and every door
 * draws from it.
 *
 * This row mutates that registration, because it is now the whole of what puts the findings in an
 * automatic evaluation. The replacement keeps a supplier registered and empties it rather than
 * deleting the call, because an empty supplier is exactly the state the defect produced -- a report
 * evaluated without them -- while a deleted call would also stop exercising the seam's type. The
 * killing row drives a real `reconcileContinuity` with such a holder connected, then reads the
 * `DOCTOR_REPORT` that pass audited and the status it persisted to `health.json`.
 */
const theAutomaticRefreshCarriesTheSupplementalFindings = {
  id: "the-automatic-refresh-carries-the-supplemental-findings",
  what: "the daemon's automatic doctor refresh includes the supplemental findings it persists a status from",
  file: "src/daemon/daemon.ts",
  find: "    this.cp.doctor.setSupplementalFindings(this.#doctorSupplier);\n",
  replace: "    this.cp.doctor.setSupplementalFindings(() => []);\n",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::the automatic refresh does not persist HEALTHY while a connected holder is outside the set",
  ],
};

export default theAutomaticRefreshCarriesTheSupplementalFindings;
