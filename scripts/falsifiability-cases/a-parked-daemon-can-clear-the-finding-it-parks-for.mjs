/**
 * The half of the dead-binding change that must never stand alone.
 *
 * Admitting CTO_BINDING_POINTS_AT_DEAD_SESSION into `canParkForBootstrap` is only safe because
 * `OPERATOR_METHOD.BINDING_RECOVER_DEAD` is on the parked daemon's admitted method set. Removing
 * the admission puts the daemon back where the defect measured on 2026-09-08 left it: start()
 * denies DOCTOR_ERROR and exits, and the recovery the finding recommends lives behind a door that
 * only opens after start() has already succeeded.
 */
const aParkedDaemonCanClearTheFindingItParksFor = {
  id: "a-parked-daemon-can-clear-the-finding-it-parks-for",
  what: "a dead canonical binding parks the daemon instead of ending the process",
  file: "src/daemon/daemon.ts",
  find: '      finding.code === "CTO_BINDING_POINTS_AT_DEAD_SESSION",\n',
  replace: '      false,\n',
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::parks, is recovered through the restricted door, and then promotes",
  ],
};

export default aParkedDaemonCanClearTheFindingItParksFor;
