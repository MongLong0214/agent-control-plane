/**
 * #954. The CTO launch and continuity provisioning paths record a session's start as `ps -o lstart=`
 * text, so a hold that could only read native tokens held none of them. The mutant refuses every
 * lstart record, so an ordinary session is revoked on the first tick of a gap.
 */
const aCoverageHoldReadsAnLstartRecordAsLstart = {
  id: "a-coverage-hold-reads-an-lstart-record-as-lstart",
  what: "a coverage hold reads a session's start again in the ps lstart form it was recorded in",
  file: "src/daemon/daemon.ts",
  find: "  if (read.lstart(session.osPid) !== session.osProcessStartedAt) return false;\n",
  replace: "  if (read.lstart(session.osPid) !== null) return false;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::holds a session recorded the ordinary way, by ps lstart text",
  ],
};

export default aCoverageHoldReadsAnLstartRecordAsLstart;
