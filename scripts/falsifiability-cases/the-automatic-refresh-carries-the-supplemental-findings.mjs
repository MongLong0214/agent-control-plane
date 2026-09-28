/**
 * The automatic doctor refresh carries the daemon's supplemental findings.
 *
 * Only the operator's `DOCTOR_RUN` used to pass them, so a connected holder outside the qualified
 * set made an on-demand report `DEGRADED` while the next reconciliation, clean in every other
 * respect, persisted `HEALTHY` to `health.json`. The findings are now read inside
 * `runSystemDoctorCheck`, which every automatic path calls. The killing row drives a real
 * `reconcileContinuity` with such a holder connected and reads `health.json`.
 */
const theAutomaticRefreshCarriesTheSupplementalFindings = {
  id: "the-automatic-refresh-carries-the-supplemental-findings",
  what: "the daemon's automatic doctor refresh includes the supplemental findings it persists a status from",
  file: "src/daemon/daemon.ts",
  find: '      report = await this.cp.doctor.run("system", undefined, this.supplementalSystemFindings());\n',
  replace: '      report = await this.cp.doctor.run("system", undefined, []);\n',
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::the automatic refresh does not persist HEALTHY while a connected holder is outside the set",
  ],
};

export default theAutomaticRefreshCarriesTheSupplementalFindings;
