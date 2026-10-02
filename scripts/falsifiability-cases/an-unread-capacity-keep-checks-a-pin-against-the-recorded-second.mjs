/**
 * ACP1045-R3-01. A pin is compared only for a live process that started in the recorded lstart
 * second. The mutant is the order 1ee2363c had: the pin accepted before the second was checked, so
 * a pin written for a successor kept the binding beside the original's lstart.
 */
const anUnreadCapacityKeepChecksAPinAgainstTheRecordedSecond = {
  id: "an-unread-capacity-keep-checks-a-pin-against-the-recorded-second",
  what: "a pin that contradicts its row's lstart second does not keep a binding through an unread provider",
  file: "src/daemon/daemon.ts",
  find: "    if (!nativeStartIsInLstartSecond(live, session.osProcessStartedAt)) return false;\n    const pinned = this.cp.sessions.pinnedNativeStart(session.sessionId);\n    if (pinned !== null) return pinned === live;\n",
  replace: "    const pinned = this.cp.sessions.pinnedNativeStart(session.sessionId);\n    if (pinned !== null) return pinned === live;\n    if (!nativeStartIsInLstartSecond(live, session.osProcessStartedAt)) return false;\n",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::does not keep an lstart row whose pin contradicts its recorded second",
  ],
};

export default anUnreadCapacityKeepChecksAPinAgainstTheRecordedSecond;
