/**
 * Every arm must have observed a baseline turn before the injection point.
 *
 * `followUpAfterInjection` is "a turn arrived that the baseline had not already produced". With a
 * zero baseline that is a comparison against a turn nobody observed, so the arm's whole result is a
 * statement about a session that was never seen to start. Reproduced on copies of all three
 * committed readings: every baseline count set to zero, totals made consistent, and every offline
 * check still passed.
 *
 * The mutation relaxes the threshold to "not negative", which no count ever is -- the shape a
 * boundary check fails in. The killing row zeroes one arm's baseline and keeps its total consistent
 * with it, so nothing else in the reading is wrong.
 */
const anArmWithNoBaselineTurnQualifiesNothing = {
  id: "an-arm-with-no-baseline-turn-qualifies-nothing",
  what: "a reading qualifies a build only when every arm observed a baseline turn before its injection point",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      if (run.baselineModelRequests < 1) {\n",
  replace: "      if (run.baselineModelRequests < 0) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm's counts have to agree with each other and with a turn having happened",
  ],
};

export default anArmWithNoBaselineTurnQualifiesNothing;
