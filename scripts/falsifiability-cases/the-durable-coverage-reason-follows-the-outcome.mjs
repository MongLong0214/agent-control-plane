/**
 * #954, review R1015-3. `continuity_state.reason_code` was written only on a mode transition, and
 * DEGRADED is both a whole plan with a fallback holder and a partial one with a role awaiting a
 * claim. Moving between those two left the durable row saying FULL_COVERAGE while every plan said
 * PARTIAL_COVERAGE.
 *
 * The mutant restores the same-mode write of `evaluated_at` alone. The killing test takes the row to
 * DEGRADED/FULL_COVERAGE through a fallback holder, revokes the role for want of coverage, and
 * asserts the row reads DEGRADED/PARTIAL_COVERAGE after the next evaluation.
 */
const theDurableCoverageReasonFollowsTheOutcome = {
  id: "the-durable-coverage-reason-follows-the-outcome",
  what: "an evaluation that changes the coverage outcome but not the mode rewrites the stored reason",
  file: "src/continuity/continuity-kernel.ts",
  find:
    "        this.db.run(`UPDATE continuity_state SET reason_code = ?, evaluated_at = ? WHERE id = 1`, [\n" +
    "          plan.outcome,\n" +
    "          this.clock.nowIso(),\n" +
    "        ]);\n",
  replace: "        this.db.run(`UPDATE continuity_state SET evaluated_at = ? WHERE id = 1`, [this.clock.nowIso()]);\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::rewrites the durable reason when the outcome changes and the mode does not",
  ],
};

export default theDurableCoverageReasonFollowsTheOutcome;
