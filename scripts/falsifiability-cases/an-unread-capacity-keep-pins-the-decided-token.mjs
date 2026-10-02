/**
 * The legacy rule pins the live token the moment it decides, so every later pass is exact.
 */
const anUnreadCapacityKeepPinsTheDecidedToken = {
  id: "an-unread-capacity-keep-pins-the-decided-token",
  what: "a legacy lstart row kept through an unread provider has its native token pinned",
  file: "src/daemon/daemon.ts",
  find: "    this.cp.sessions.pinNativeStart(session.sessionId, live);\n    return true;\n  }\n",
  replace: "    return true;\n  }\n",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::keeps a legacy lstart row written after its process's start second, pins the token, then compares the pin",
  ],
};

export default anUnreadCapacityKeepPinsTheDecidedToken;
