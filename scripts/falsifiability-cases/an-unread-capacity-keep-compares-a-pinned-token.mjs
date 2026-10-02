/**
 * Once a token is pinned the decision is exact. Without the comparison a successor that started in
 * the recorded process's own second has the same lstart and passes the legacy rule again.
 */
const anUnreadCapacityKeepComparesAPinnedToken = {
  id: "an-unread-capacity-keep-compares-a-pinned-token",
  what: "a successor inside the recorded second is refused once the incumbent's token is pinned",
  file: "src/daemon/daemon.ts",
  find: "    const pinned = this.cp.sessions.pinnedNativeStart(session.sessionId);\n    if (pinned !== null) return pinned === live;\n",
  replace: "    const pinned = this.cp.sessions.pinnedNativeStart(session.sessionId);\n    void pinned;\n",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::keeps a legacy lstart row written after its process's start second, pins the token, then compares the pin",
  ],
};

export default anUnreadCapacityKeepComparesAPinnedToken;
