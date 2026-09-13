/**
 * #880 — the throw bucket is measured against the frames that produced a verdict, not against
 * every frame that arrived.
 *
 * `BuzzMentionCounters` states the identity this rests on:
 *
 *     framesHandled = admitted + Σrejections + protocol frames + frames whose connection was
 *                     replaced mid-answer
 *
 * The third term is the one that makes `framesHandled` the wrong denominator. Every live
 * connection carries an AUTH challenge, its NIP-42 `OK`, an `EOSE` and any `NOTICE`, and all four
 * return `ACCEPTED` without producing a verdict. So `frame-handler-threw === framesHandled` can
 * never hold on a real subscriber, and the finding would be **dead in production while green in a
 * unit test** — the test sends no protocol frames, so the two numbers agree there and nowhere else.
 *
 * That is why the mutation is `counters.framesHandled` rather than a deletion. Collapsing the
 * denominator is the plausible simplification: it is shorter, it typechecks, it reads as the same
 * quantity, and three of the four cases in the named test file still pass. Only the case built to
 * separate them — twelve frames handled, two verdicts, both throws — reads a different value.
 *
 * Measured before this prose was written: `--only` reports `killed`, and the four cases pass 4/4
 * on the unmutated tree.
 */
const handlingThatFailsIsMeasuredAgainstVerdicts = {
  id: "handling-that-fails-is-measured-against-verdicts",
  what:
    "the handling-failing finding compares the throw bucket against the frames that produced a verdict, "
    + "so protocol frames that carry none cannot dilute it into a condition no live subscriber can meet",
  file: "src/daemon/daemon.ts",
  find: "    const verdicts =\n      counters.admitted + Object.values(counters.rejections).reduce((sum, one) => sum + one, 0);\n",
  replace: "    const verdicts = counters.framesHandled;\n",
  killedBy: [
    "tests/unit/a-subscriber-whose-handling-fails-is-not-silent.test.ts::counts the denominator as verdicts, not as frames, so protocol traffic cannot dilute it",
  ],
};

export default handlingThatFailsIsMeasuredAgainstVerdicts;
