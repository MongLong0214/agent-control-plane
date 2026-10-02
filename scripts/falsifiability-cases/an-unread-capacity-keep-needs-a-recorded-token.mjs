/**
 * A session that recorded no start token cannot be kept: compared without that guard, an unread
 * token (null) equals an unrecorded one (null), and a pid nothing can identify would hold its
 * binding for as long as the provider stays unread.
 */
const anUnreadCapacityKeepNeedsARecordedToken = {
  id: "an-unread-capacity-keep-needs-a-recorded-token",
  what: "an incumbent with no recorded start token is not kept through an unread provider",
  file: "src/daemon/daemon.ts",
  find: "    if (session.osPid == null) return false;\n    if (session.osProcessStartedAt == null) return false;\n",
  replace: "    if (session.osPid == null) return false;\n",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::does not keep an incumbent whose start token was never recorded",
  ],
};

export default anUnreadCapacityKeepNeedsARecordedToken;
