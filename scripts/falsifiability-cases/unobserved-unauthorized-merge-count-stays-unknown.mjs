/**
 * #740's headline allegation was that `unauthorizedMergeCountsObserved = productionRuns.length > 0`
 * lets an unwritten count report as an *observed* zero — the system claiming no unauthorized merge
 * happened on the strength of never having looked.
 *
 * It does not. The loop walks that same array, and this `else` lowers the flag for any production
 * run carrying no count, so the output is `null` and a gap is raised. Measured against `ff0afa3`:
 * a genuinely completed production run reports `unauthorizedMerges: null`, and the only route to a
 * `0` is a fixture with the key injected by hand.
 *
 * So this row does not guard against a bug that was found. It encodes a false allegation as a
 * mutation: delete the `else` and the allegation becomes true, and a test dies saying so. The
 * claim was wrong on the day it was written, and it cannot quietly become right.
 */
const unobservedUnauthorizedMergeCountStaysUnknown = {
  id: "unobserved-unauthorized-merge-count-stays-unknown",
  what: "#740: a production run carrying no unauthorized-merge count lowers the observed flag",
  file: "src/export/run-evidence.ts",
  find:
    "    } else {\n" +
    "      unauthorizedMergeCountsObserved = false;\n" +
    "    }\n",
  replace: "    }\n",
  killedBy: [
    "tests/unit/baseline-export.test.ts::reports an unknown unauthorized-merge count for a completed production run that recorded no quality observation",
  ],
};

export default unobservedUnauthorizedMergeCountStaysUnknown;
