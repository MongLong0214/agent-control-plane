/**
 * #885 — a changed file whose import edges nobody determined puts the whole table in scope.
 *
 * This is the operand the whole selection rests on. The affected closure narrows a pull request
 * from 624 mutation rows to the ones a change can break, and that narrowing is only sound while
 * "this file affects nothing" is an answer somebody has. Deleting the undecidable branch does not
 * look like a fail-open: the function still returns a selection, the selection is still derived
 * from real edges, and every other case in its test file still passes. What it silently changes is
 * the meaning of an absent answer — from "run everything" to "run nothing for this file".
 *
 * The CEO refused the first version of this selection for exactly that direction: deferring a
 * cross-file regression to the `main` sweep is a quality reduction, and `main`'s full sweep is
 * additional defence rather than a substitute for what a pull request missed. An undecidable
 * dependency read as unaffected is that same deferral, arrived at by accident instead of by
 * proposal.
 *
 *
 * Measured with `--only` before this prose was written: `killed`. The file's eleven cases pass
 * unmutated, which is the baseline that kill rests on — the harness's own baseline artifact is a
 * CI result set and was not supplied to these local runs, so it says so rather than assuming it.
 */
const anUnanswerableDependencyIsNotAnUnaffectedOne = {
  id: "an-unanswerable-dependency-is-not-an-unaffected-one",
  what:
    "a changed file whose import edges the caller could not determine puts every row in scope, "
    + "rather than being read as a file that affects nothing",
  file: "scripts/lib/affected-closure.mjs",
  find: "  if (undecidable.length > 0) {\n",
  replace: "  if (false) {\n",
  killedBy: [
    "tests/unit/the-affected-closure-selects-what-a-change-can-break.test.ts::4 — a changed file whose import edges the caller could not determine is FULL, and names it",
  ],
};

export default anUnanswerableDependencyIsNotAnUnaffectedOne;
