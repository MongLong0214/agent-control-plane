/**
 * A qualification is exactly one of each of the four arms: injection against control, in both
 * shapes.
 *
 * The ceremony's claim is a comparison -- the wake arrives in the injection arms and nothing
 * arrives in the controls -- and a set of observations missing one side of it is not that
 * comparison. Reproduced on in-memory copies of all three committed readings: with both headless
 * arms deleted, every offline check still passed, and `buildReceipt` itself returned "qualified"
 * for an interactive pair with no headless arms at all.
 *
 * The mutation makes the count agree with itself, which is the shape this kind of check fails in:
 * it still runs, still reads the right field, and can never report anything. The killing row
 * deletes the two headless arms, and separately repeats one arm twice so that a bare length check
 * would not have caught it.
 */
const aQualificationIsOneOfEachOfTheFourArms = {
  id: "a-qualification-is-one-of-each-of-the-four-arms",
  what: "a reading qualifies a build only when it holds exactly one of each of the four arms",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    if (found !== 1) {\n",
  replace: "    if (found !== found) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::a qualification is four arms: injection against control, in both shapes",
  ],
};

export default aQualificationIsOneOfEachOfTheFourArms;
