/**
 * ACP1045-R2-01 (c). Continuity provisioning keeps `ps` lstart in the row for the readers that
 * compare it, and pins the exact native token beside it so the unread-capacity keep is exact.
 */
const continuityProvisioningPinsTheNativeStart = {
  id: "continuity-provisioning-pins-the-native-start",
  what: "a session continuity provisions has its native start token pinned",
  file: "src/continuity/continuity-kernel.ts",
  find: "    if (startToken !== null) this.sessions.pinNativeStart(session.sessionId, startToken);\n",
  replace: "    void startToken;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::pins the native token of a session continuity provisions, beside the lstart it records",
  ],
};

export default continuityProvisioningPinsTheNativeStart;
