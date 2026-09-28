/**
 * A sequence the screen model does not apply is recorded, by name, on the screen it rendered.
 *
 * The model is an allow-list: a sequence it applies, one it knows changes no cell, or neither. The
 * third set is the defect's surface -- a screen drawn with a sequence nobody modelled is a screen
 * the model may have wrong -- and the record is the only thing that makes it visible. Stop
 * recording and every such screen reads as fully applied again. The killing row sends ten
 * sequences from that set, each through `describeReadiness`, and requires each to be named.
 */
const anUnmodelledSequenceIsRecorded = {
  id: "an-unmodelled-sequence-is-recorded",
  what: "the screen model records every sequence it does not apply, by name",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    if (!unmodelled.includes(name)) unmodelled.push(name);\n",
  replace: "    if (unmodelled.includes(name)) unmodelled.push(name);\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a sequence that would move cells and is not modelled refuses the screen and is named",
  ],
};

export default anUnmodelledSequenceIsRecorded;
