/**
 * ACP1045-R2-01 (c). The CTO launch keeps `ps` lstart in the row for the readers that compare it,
 * and pins the exact native token beside it so the unread-capacity keep is exact for new rows.
 */
const ctoLaunchPinsTheNativeStart = {
  id: "cto-launch-pins-the-native-start",
  what: "a launched CTO session has its native start token pinned",
  file: "src/cto/cto-lifecycle.ts",
  find: "    if (startToken !== null) this.sessions.pinNativeStart(session.sessionId, startToken);\n",
  replace: "    void startToken;\n",
  killedBy: [
    "tests/unit/cto-registry-r2.test.ts::ACP1045-R2-01 pins the launched CTO's native start beside the lstart it records",
  ],
};

export default ctoLaunchPinsTheNativeStart;
