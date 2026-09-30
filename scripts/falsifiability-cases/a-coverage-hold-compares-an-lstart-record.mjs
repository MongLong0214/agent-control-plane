/**
 * #954. An lstart record is held only if the running process's lstart is the recorded one. The mutant
 * drops that comparison, so a process with a different start is held whenever it predates the row.
 */
const aCoverageHoldComparesAnLstartRecord = {
  id: "a-coverage-hold-compares-an-lstart-record",
  what: "a coverage hold refuses an lstart record that is not the running process's start",
  file: "src/daemon/daemon.ts",
  find: "  if (processStartedAt(session.osPid) !== session.osProcessStartedAt) return false;\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::revokes at once an lstart record that is not this process's start",
  ],
};

export default aCoverageHoldComparesAnLstartRecord;
