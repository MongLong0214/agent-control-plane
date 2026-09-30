/**
 * #954. lstart text has whole-second precision, so a replacement started in the same second would
 * compare equal. The running process's native start must precede the session row, which a
 * replacement cannot. The mutant drops that ordering and holds a process that began after its row.
 */
const aCoverageHoldOrdersTheProcessBeforeItsRow = {
  id: "a-coverage-hold-orders-the-process-before-its-row",
  what: "a coverage hold refuses an lstart record whose running process started after the session row",
  file: "src/daemon/daemon.ts",
  find: "  return Number(started[1]) * 1000 + Number(started[2]) / 1000 <= Date.parse(session.createdAt);\n",
  replace: "  return true;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::revokes at once an lstart record whose running process started after its row",
  ],
};

export default aCoverageHoldOrdersTheProcessBeforeItsRow;
