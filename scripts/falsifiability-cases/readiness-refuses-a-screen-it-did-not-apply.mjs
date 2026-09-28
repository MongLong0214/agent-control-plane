/**
 * Readiness refuses a screen the model did not apply in full, even with the cursor on a caret.
 *
 * Recording an unmodelled sequence is half the repair; the decision has to read the record. A
 * cursor at rest on an inverse blank means a drawn caret only if the model put every cell where the
 * terminal put it, and on a screen carrying a sequence the model skipped it cannot say that.
 */
const readinessRefusesAScreenItDidNotApply = {
  id: "readiness-refuses-a-screen-it-did-not-apply",
  what: "interactive readiness refuses a screen the model did not apply every sequence of",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "  const ready = cursorOnCaret && rendered.unmodelled.length === 0;\n",
  replace: "  const ready = cursorOnCaret;\n",
  killedBy: [
    "tests/feasibility/wake-transport-readiness.test.ts::a sequence that would move cells and is not modelled refuses the screen and is named",
  ],
};

export default readinessRefusesAScreenItDidNotApply;
