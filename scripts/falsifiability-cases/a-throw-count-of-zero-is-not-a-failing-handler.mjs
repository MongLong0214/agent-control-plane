/**
 * #880 — the positivity half of the handling-failing condition.
 *
 * `handlerThrew === verdicts` is true of a subscriber that has produced **no verdicts at all**:
 * zero equals zero. A connection that authenticated, reached `EOSE` and has been sent nothing is
 * exactly that state, and it is the one `BUZZ_MENTION_SUBSCRIBER_SILENT` owns — with a grace
 * window, because silence means nothing yet on a subscriber that started ninety seconds ago.
 *
 * Without `handlerThrew > 0` this finding takes that state instead, immediately and with no
 * window, and reports a handler that has never run as the thing that is failing. Two findings then
 * describe the same subscriber from opposite sides, which is the misdirection #870 set out to end.
 *
 * The mutation deletes the positivity test and leaves an equality that still typechecks and still
 * reads as the same intent. Four of the five cases in the named file continue to pass; only the
 * one built with an empty rejection map and no admissions reads a different value.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const aThrowCountOfZeroIsNotAFailingHandler = {
  id: "a-throw-count-of-zero-is-not-a-failing-handler",
  what:
    "the handling-failing finding requires at least one throw, so a subscriber that has produced no "
    + "verdicts at all is left to the silent finding and its grace window rather than reported as failing",
  file: "src/daemon/daemon.ts",
  find: "    if (handlerThrew > 0 && handlerThrew === verdicts) {\n",
  replace: "    if (handlerThrew === verdicts) {\n",
  killedBy: [
    "tests/unit/a-subscriber-whose-handling-fails-is-not-silent.test.ts::stays quiet when no frame has produced a verdict at all — zero throws out of zero is not failing",
  ],
};

export default aThrowCountOfZeroIsNotAFailingHandler;
