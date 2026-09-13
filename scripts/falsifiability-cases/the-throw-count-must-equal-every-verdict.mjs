/**
 * #880 — the equality half of the handling-failing condition, and the reason this finding needs no
 * window, ratio or run counter.
 *
 * One transient throw on a live relay is ordinary. A finding that fired on any nonzero
 * `frame-handler-threw` would be a WARN per occurrence, which is the noise that got `role-not-held`
 * reporting rejected in #811 — a line an operator filters out is the same silence spelled
 * differently.
 *
 * The equality is what makes the condition self-limiting: one frame that produced any other
 * verdict breaks it permanently for this process. That is why no decay, sampling or window is
 * needed, and it is the property the mutation removes — deleting the equality leaves
 * `handlerThrew > 0`, which is precisely the rejected shape, and it typechecks and reads as a
 * simplification.
 *
 * Sibling row `a-throw-count-of-zero-is-not-a-failing-handler` mutates the other half of the same
 * line. Two rows on one line is deliberate here and is a known cost: an edit to this condition
 * kills both anchors at once, and `--anchors-only` is what reports that in seconds rather than
 * forty minutes.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const theThrowCountMustEqualEveryVerdict = {
  id: "the-throw-count-must-equal-every-verdict",
  what:
    "the handling-failing finding requires every verdict-carrying frame to have thrown, so a single "
    + "transient throw beside a delivery does not raise it",
  file: "src/daemon/daemon.ts",
  find: "    if (handlerThrew > 0 && handlerThrew === verdicts) {\n",
  replace: "    if (handlerThrew > 0) {\n",
  killedBy: [
    "tests/unit/a-subscriber-whose-handling-fails-is-not-silent.test.ts::stays quiet once any frame produced a different verdict — one transient throw is not this",
  ],
};

export default theThrowCountMustEqualEveryVerdict;
