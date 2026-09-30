/**
 * #954. Only the incumbent's exact process, by native pid and start token, earns a hold. The mutant
 * drops the start-token comparison, so a reused pid holds a binding its session no longer has.
 */
const aCoverageHoldNeedsTheExactProcess = {
  id: "a-coverage-hold-needs-the-exact-process",
  what: "a coverage hold refuses an incumbent whose recorded start token is not the running process's",
  file: "src/daemon/daemon.ts",
  find: "    if (session.osProcessStartedAt !== readProcessStartToken(session.osPid)) return false;\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::revokes at once a reused pid whose start token is not the one it recorded",
  ],
};

export default aCoverageHoldNeedsTheExactProcess;
