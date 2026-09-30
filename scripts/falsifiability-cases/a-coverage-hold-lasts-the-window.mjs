/**
 * #954. The hold is bounded: it lasts `COVERAGE_REVOCATION_GRACE_MS` from the first tick of the gap.
 * The mutant ends it on the second tick, so a gap still inside the window revokes the binding.
 */
const aCoverageHoldLastsTheWindow = {
  id: "a-coverage-hold-lasts-the-window",
  what: "a held role keeps its binding on every tick until the grace window has passed",
  file: "src/daemon/daemon.ts",
  find: "    return nowMs - Date.parse(heldAt) < COVERAGE_REVOCATION_GRACE_MS;\n",
  replace: "    return false;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::records the hold once and keeps holding while the window lasts",
  ],
};

export default aCoverageHoldLastsTheWindow;
