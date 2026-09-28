/**
 * A count a reading does not carry is a failure, not a rule that was satisfied.
 *
 * These rules read committed JSON, where a field can simply be missing -- the readings committed
 * until 2026-09-28 carried no per-arm digest at all, and nothing failed. Every comparison against
 * an absent number is false, so a missing `baselineModelRequests` would have satisfied "the
 * baseline is positive", "the total is at least the baseline" and the follow-up agreement rule at
 * once. Absence is established first, and the rules run only on what is a count.
 *
 * The mutation accepts anything that is a number rather than requiring a count to be present at
 * all, which is the form this check quietly fails in. The killing row deletes one arm's baseline
 * count and leaves the reading otherwise intact.
 */
const aCountThatIsAbsentIsNotACountThatPassed = {
  id: "a-count-that-is-absent-is-not-a-count-that-passed",
  what: "a reading whose arm does not carry one of its turn counts is refused rather than passing the rules about it",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    const missing = counts.filter(([, value]) => !Number.isInteger(value) || value < 0);\n",
  replace: "    const missing = counts.filter(([, value]) => Number.isNaN(value));\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm's counts have to agree with each other and with a turn having happened",
  ],
};

export default aCountThatIsAbsentIsNotACountThatPassed;
