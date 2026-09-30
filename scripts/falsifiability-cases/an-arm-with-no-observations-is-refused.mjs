/**
 * An arm that committed no observations is refused, not admitted on its own integers.
 *
 * Absence is the case that has slipped through every earlier version of these rules: the committed
 * readings carried no per-arm image digest and the digest rule passed on them, and a missing count
 * compared false against every threshold beneath it. The same shape applies here -- a reading
 * written before the observations existed, or one with the record quietly dropped, is exactly the
 * reading whose counts nothing checks, and it is the one that most needs refusing.
 *
 * The mutation folds absence into silence: the arm without observations produces no shortfall and
 * the reading is admitted. The killing row drops the record from one arm of an otherwise passing
 * reading and requires it to be named, with the stored verdict's disagreement beside it.
 */
const anArmWithNoObservationsIsRefused = {
  id: "an-arm-with-no-observations-is-refused",
  what: "the acceptance rule refuses an arm that carries no observations rather than accepting the counts it states",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "      shortfalls.push(`${where} carries no observations, so its counts are claims this file makes about itself`);\n",
  replace: "",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm's counts have to come from the observations committed with it",
  ],
};

export default anArmWithNoObservationsIsRefused;
