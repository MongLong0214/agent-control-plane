/**
 * #639. The guard above can only be as honest as the fact fed into it. `completeDirectRoute` is
 * the one place that knows whether the DIRECT handler answered or composed a substitute, and
 * hard-coding `true` here makes every apology claim to be a CEO answer while the guard, the row
 * and doctor all agree with it.
 */
const aDaemonComposedSentenceIsNotRecordedAsAnAnswer = {
  id: "a-daemon-composed-sentence-is-not-recorded-as-an-answer",
  what: "the DIRECT route reports the handler's own verdict on whether it answered, not a constant",
  file: "src/ingress/telegram-router.ts",
  find: "        turnAnswered: answer.answered,\n",
  replace: "        turnAnswered: true,\n",
  killedBy: [
    "tests/unit/a-timeout-apology-is-not-an-answer.test.ts::leaves the turn unresolved while the reply's own lifecycle records that it was delivered",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDaemonComposedSentenceIsNotRecordedAsAnAnswer;
