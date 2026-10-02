/**
 * Unknown capacity keeps a binding only for the exact process it recorded. Answering true without
 * the pid and start-token test would keep a binding whose process is gone — the thing a missing
 * reading cannot vouch for, and the one case continuity must still revoke at once.
 */
const anUnreadCapacityKeepsOnlyTheRecordedProcess = {
  id: "an-unread-capacity-keeps-only-the-recorded-process",
  what: "an incumbent whose recorded process is gone is revoked although its provider has no reading",
  file: "src/daemon/daemon.ts",
  find: "    if (session.osProcessStartedAt === live) return true;\n    if (NATIVE_START_TOKEN.test(session.osProcessStartedAt)) return false;\n",
  replace: "    if (session.osProcessStartedAt !== null) return true;\n    if (NATIVE_START_TOKEN.test(session.osProcessStartedAt)) return false;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::still revokes at once an incumbent whose recorded process is gone",
  ],
};

export default anUnreadCapacityKeepsOnlyTheRecordedProcess;
