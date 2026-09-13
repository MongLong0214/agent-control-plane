/**
 * (prose pending — row exercised with --only before this is written)
 */
const handlingThatFailsIsMeasuredAgainstVerdicts = {
  id: "handling-that-fails-is-measured-against-verdicts",
  what: "placeholder",
  file: "src/daemon/daemon.ts",
  find: "    const verdicts =\n      counters.admitted + Object.values(counters.rejections).reduce((sum, one) => sum + one, 0);\n",
  replace: "    const verdicts = counters.framesHandled;\n",
  killedBy: [
    "tests/unit/a-subscriber-whose-handling-fails-is-not-silent.test.ts::counts the denominator as verdicts, not as frames, so protocol traffic cannot dilute it",
  ],
};

export default handlingThatFailsIsMeasuredAgainstVerdicts;
