/**
 * A reading whose verdict is not `qualified` must not make its build a member.
 *
 * The feasibility test's agreement rules are the only thing that ties the qualified set to its
 * readings, and this is the rule a failed measurement has to trip: the reading exists, its file is
 * named correctly, and it is of a member exactly, so every other rule is satisfied. Without the
 * verdict comparison a build that was measured and failed would stand in the set as if it had
 * passed, which is worse than no reading at all — it looks like evidence.
 *
 * The committed set cannot exercise this, because its one reading passed, so the killing row is a
 * fixture: two members, one of them resting on a reading the instrument itself marked
 * `not-qualified` from the arms it ran.
 */
const aMemberOnAFailedReadingIsRefused = {
  id: "a-member-on-a-failed-reading-is-refused",
  what: "the feasibility check refuses a qualified member whose reading's verdict is not qualified",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '      if (reading.verdict !== "qualified") {\n',
  replace: "      if (reading.verdict !== reading.verdict) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::a member resting on a reading whose verdict is not qualified is a failure",
  ],
};

export default aMemberOnAFailedReadingIsRefused;
