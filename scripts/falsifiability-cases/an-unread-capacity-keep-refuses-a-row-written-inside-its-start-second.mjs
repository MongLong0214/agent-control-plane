/**
 * ACP1045-R1-01 under the legacy lstart rule. A row written inside its process's own start second
 * cannot tell that process from a successor that took the pid later in the same second, so it is
 * not decisive and is not kept. Without this line the same-millisecond replacement is kept again.
 */
const anUnreadCapacityKeepRefusesARowWrittenInsideItsStartSecond = {
  id: "an-unread-capacity-keep-refuses-a-row-written-inside-its-start-second",
  what: "a reused pid inside the row's start second does not keep a binding through an unread provider",
  file: "src/daemon/daemon.ts",
  find: "    if (Date.parse(session.createdAt) < recordedSecond + 1000) return false;\n    this.cp.sessions.pinNativeStart(session.sessionId, live);\n",
  replace: "    this.cp.sessions.pinNativeStart(session.sessionId, live);\n",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::does not keep a reused pid whose replacement started later inside the row's millisecond",
  ],
};

export default anUnreadCapacityKeepRefusesARowWrittenInsideItsStartSecond;
