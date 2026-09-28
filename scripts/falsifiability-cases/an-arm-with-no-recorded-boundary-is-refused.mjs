/**
 * An arm whose observations do not say where the frame was written is refused, not read positionally.
 *
 * Absence is the case these rules keep losing: a reading written before this field existed, or one
 * with the record dropped, carries requests that are all equally "before" and "after". `countsFrom`
 * answers conservatively for such a record -- every turn is before the boundary, so no follow-up
 * exists -- but an answer is not a refusal, and the control arm's criterion is satisfied by exactly
 * that shape. So the reading has to be named rather than quietly counted.
 *
 * The mutation folds the absence into silence. The killing row drops the boundary from one arm of
 * an otherwise passing reading, and asks for it by name.
 */
const anArmWithNoRecordedBoundaryIsRefused = {
  id: "an-arm-with-no-recorded-boundary-is-refused",
  what: "the acceptance rule refuses an arm whose observations do not record where in them the frame was written",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "        shortfalls.push(\n" +
    "          `${where} does not record where in the requests it observed the frame was written, so which of them ` +\n" +
    "            `preceded it is a guess`,\n" +
    "        );\n",
  replace: "",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm that does not say where its frame went, or says it went somewhere its own arm did not, is refused",
  ],
};

export default anArmWithNoRecordedBoundaryIsRefused;
