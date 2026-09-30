/**
 * An arm's `followUpAfterInjection` must say what its own counts say.
 *
 * `armPassed` reads the summary field, not the counts, so without this rule the summary *is* the
 * measurement: a reading whose arm claims a follow-up arrived while its total equals its baseline
 * passes every other check. The instrument computes the two together, so they can only disagree in
 * a file that was written by something else -- which is exactly the file these rules exist to
 * refuse.
 *
 * The mutation compares the field with itself, which still reads the right field and can never
 * report. The killing row leaves the summary saying a follow-up arrived and makes the counts say it
 * did not.
 */
const anArmsSummaryAgreesWithItsOwnCounts = {
  id: "an-arms-summary-agrees-with-its-own-counts",
  what: "a reading qualifies a build only when each arm's follow-up summary agrees with the turn counts beside it",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      if (run.followUpAfterInjection !== run.modelRequests > run.baselineModelRequests) {\n",
  replace: "      if (run.followUpAfterInjection !== run.followUpAfterInjection) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm's counts have to agree with each other and with a turn having happened",
  ],
};

export default anArmsSummaryAgreesWithItsOwnCounts;
