/**
 * #954. `createdAt` is truncated to the millisecond, so a process that began earlier in the same
 * millisecond reads as later than its row unless the start is truncated too. The mutant compares the
 * microsecond start and refuses that incumbent.
 */
const aCoverageHoldComparesTheStartAtMillisecondResolution = {
  id: "a-coverage-hold-compares-the-start-at-millisecond-resolution",
  what: "a coverage hold compares a native start with its session row at millisecond resolution",
  file: "src/daemon/daemon.ts",
  find: "  return Number(started[1]) * 1000 + Math.floor(Number(started[2]) / 1000) <= Date.parse(session.createdAt);\n",
  replace: "  return Number(started[1]) * 1000 + Number(started[2]) / 1000 <= Date.parse(session.createdAt);\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::accepts a process that began earlier in the same millisecond its row was written",
  ],
};

export default aCoverageHoldComparesTheStartAtMillisecondResolution;
