/**
 * The snapshot's token must fall in the second its lstart names, so the row and the pin describe
 * one start. An lstart rendered in another zone would otherwise sit beside a token it contradicts.
 */
const registrationPinsOnlyATokenInTheLstartSecond = {
  id: "registration-pins-only-a-token-in-the-lstart-second",
  what: "a registration whose token is outside its lstart's second leaves the row unpinned",
  file: "src/session/session-registry.ts",
  find: "  if (!nativeStartIsInLstartSecond(before, startedAt)) return null;\n",
  replace: "",
  killedBy: [
    "tests/unit/an-unread-capacity-keeps-only-the-exact-process.test.ts::does not pin a launched CTO when the lstart it reads names another second than its token",
  ],
};

export default registrationPinsOnlyATokenInTheLstartSecond;
