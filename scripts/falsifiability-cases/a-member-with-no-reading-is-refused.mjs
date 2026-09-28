/**
 * A qualified member with no reading at all fails the feasibility check — as a failure, not a
 * warning.
 *
 * This is the state the slice exists to prevent. Adding a build to the set is a one-line edit to a
 * constant, and before the readings were tied to it that edit was the whole of "qualifying" a
 * build: a conclusion with no measurement behind it, which is what the C0 pin was. The other rules
 * cannot catch it — a member with no reading has no reading to misname, and no reading to carry a
 * failed verdict.
 *
 * The killing row is a fixture: two members, one reading.
 */
const aMemberWithNoReadingIsRefused = {
  id: "a-member-with-no-reading-is-refused",
  what: "the feasibility check refuses a qualified member that has no committed reading",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    if (own.length === 0) {\n",
  replace: "    if (own.length < 0) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::a member with no reading is a failure, not a warning",
  ],
};

export default aMemberWithNoReadingIsRefused;
