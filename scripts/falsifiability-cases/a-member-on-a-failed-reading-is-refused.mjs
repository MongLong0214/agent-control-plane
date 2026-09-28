/**
 * A member's reading is admitted on its own runs, never on the verdict the file carries.
 *
 * The feasibility test's agreement rules are the only thing that ties the qualified set to its
 * readings, and this is the rule a failed measurement has to trip: the reading exists, its file is
 * named correctly, and it is of a member exactly, so every other rule is satisfied. Without it a
 * build that was measured and failed would stand in the set as if it had passed, which is worse
 * than no reading at all -- it looks like evidence.
 *
 * The check used to be `reading.verdict !== "qualified"`, which made the artefact the authority on
 * its own admissibility: two reviewers reproduced it on copies of all three committed readings, and
 * a reading with both headless arms deleted, with a failing arm, or with an interactive command the
 * production predicate refuses, was admitted because the field still said "qualified". It now
 * recomputes with `qualificationShortfalls`, the same calculation `buildReceipt` writes the verdict
 * with, and the mutation restores the old authority: if the file says qualified, ask nothing.
 *
 * The committed set cannot exercise this, because its three readings pass, so the killing row is a
 * fixture: a reading whose stored verdict says qualified and whose arms do not.
 */
const aMemberOnAFailedReadingIsRefused = {
  id: "a-member-on-a-failed-reading-is-refused",
  what: "the feasibility check recomputes whether a member's reading qualifies it, rather than reading the verdict the file states",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      for (const shortfall of qualificationShortfalls(reading.runs)) {\n",
  replace:
    '      for (const shortfall of reading.verdict === "qualified" ? [] : qualificationShortfalls(reading.runs)) {\n',
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::the stored verdict is an output that is checked, never the reason a reading is admitted",
  ],
};

export default aMemberOnAFailedReadingIsRefused;
