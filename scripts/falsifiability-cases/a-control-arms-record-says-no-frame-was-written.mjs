/**
 * An arm's recorded boundary has to agree with whether that arm says it injected.
 *
 * The control arm's whole claim is that nothing was written to the session's inbox, and its
 * boundary is the point at which the injection arm writes one. Without this check the two arms'
 * observations are interchangeable: a control's record slots into an injection arm and nothing in
 * the file contradicts it, which is how one reviewer's borrowed-observations case got as far as a
 * count comparison. Recording "no frame was written" is only worth recording if something reads it.
 *
 * The mutation drops the comparison. The killing row gives an injection arm the control's
 * observations and requires the contradiction to be named before any count is compared.
 */
const aControlArmsRecordSaysNoFrameWasWritten = {
  id: "a-control-arms-record-says-no-frame-was-written",
  what: "the acceptance rule refuses an arm whose recorded boundary disagrees with whether the arm says a frame was written",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "        if (boundary.frameWritten !== run.injected) {\n" +
    "          shortfalls.push(\n" +
    "            `${where} is recorded as ${run.injected ? \"an injection\" : \"a control\"} arm, and its observations say a ` +\n" +
    "              `frame ${boundary.frameWritten ? \"was\" : \"was not\"} written`,\n" +
    "          );\n" +
    "        }\n",
  replace: "",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm's counts have to come from the observations committed with it",
  ],
};

export default aControlArmsRecordSaysNoFrameWasWritten;
