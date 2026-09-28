/**
 * Readiness refuses a screen a sequence the model did not apply still leaves in doubt, even with
 * the cursor on a caret.
 *
 * Recording an unmodelled sequence is half the repair; the decision has to read the record. A
 * cursor at rest on an inverse blank means a drawn caret only if the model put every cell where the
 * terminal put it, and on a screen still in doubt after a sequence the model skipped it cannot say
 * that. The record read is `untrusted`, the part of `unmodelled` a repaint has not ended.
 */
const readinessRefusesAScreenItDidNotApply = {
  id: "readiness-refuses-a-screen-it-did-not-apply",
  what: "interactive readiness refuses a screen an unapplied sequence still leaves in doubt",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "  const ready = cursorOnCaret && rendered.untrusted.length === 0;\n",
  replace: "  const ready = cursorOnCaret;\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a sequence that would move cells and is not modelled refuses the screen and is named",
  ],
};

export default readinessRefusesAScreenItDidNotApply;
