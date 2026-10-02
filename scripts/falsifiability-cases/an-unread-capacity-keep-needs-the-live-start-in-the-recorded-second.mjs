/**
 * The legacy lstart rule's first half: the live native start, truncated to the second, must be the
 * recorded lstart second. Without it any process on the pid passes once the row is old enough.
 */
const anUnreadCapacityKeepNeedsTheLiveStartInTheRecordedSecond = {
  id: "an-unread-capacity-keep-needs-the-live-start-in-the-recorded-second",
  what: "a pid reused in a later second does not keep a binding through an unread provider",
  file: "src/daemon/daemon.ts",
  find: "    if (!nativeStartIsInLstartSecond(live, session.osProcessStartedAt)) return false;\n    const pinned",
  replace: "    const pinned",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::does not keep a reused pid that started in a later second than the recorded one",
  ],
};

export default anUnreadCapacityKeepNeedsTheLiveStartInTheRecordedSecond;
