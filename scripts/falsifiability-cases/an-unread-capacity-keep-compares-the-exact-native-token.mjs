/**
 * ACP1045-R1-01. The keep for an unread provider lasts for as long as the provider stays unread,
 * so it compares the exact native start token the session recorded. The mutant is the first
 * version of this change: the coverage hold's process test, whose lstart branch accepts a
 * replacement that took the pid later inside the millisecond `createdAt` is truncated to. That is
 * the hold's documented limit (r-364403fc103a), and it would keep a dead incumbent's binding.
 */
const anUnreadCapacityKeepComparesTheExactNativeToken = {
  id: "an-unread-capacity-keep-compares-the-exact-native-token",
  what: "a reused pid inside the row's millisecond does not keep a binding through an unread provider",
  file: "src/daemon/daemon.ts",
  find: "    return session.osProcessStartedAt === readProcessStartToken(session.osPid);\n  }\n\n  private holdsThroughCoverageGap(",
  replace: "    return recordedProcessIsRunning(session);\n  }\n\n  private holdsThroughCoverageGap(",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::does not keep a reused pid whose replacement started later inside the row's millisecond",
  ],
};

export default anUnreadCapacityKeepComparesTheExactNativeToken;
