/**
 * ACP1045-R3-01. Registration reads the native token, the lstart, and the native token again, and
 * pins only when the two native reads agree. Without that a successor that took the pid inside
 * the lstart's own second is indistinguishable by the text, and a token is pinned across it.
 */
const registrationPinsOnlyWhenBothNativeReadsAgree = {
  id: "registration-pins-only-when-both-native-reads-agree",
  what: "a pid taken between the reads of a registration snapshot leaves the row unpinned",
  file: "src/session/session-registry.ts",
  find: "  if (before === null) return null;\n  if (before !== after) return null;\n",
  replace: "  if (before === null) return null;\n",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::does not pin a launched CTO whose pid a successor took in the same second",
  ],
};

export default registrationPinsOnlyWhenBothNativeReadsAgree;
