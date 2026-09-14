/**
 * #655 condition 6 - an inspection that could not decide is not an inspection that found nothing.
 *
 * `contended` is `boolean | null`, and `null` is the honest answer of a probe that could not read
 * the shared Hermes database. Removing this line lets that value fall through to
 * `observation.contended ? "STOP_AND_REPORT" : "PROCEED"`, where `null` is falsy - so the run
 * **proceeds** through exactly the uncertainty the condition exists to stop for, and it does so
 * silently, because nothing about a `PROCEED` says which of the two answers produced it.
 *
 * The mutant typechecks and reads as a simplification: the remaining ternary looks total, and a
 * reader who does not know `contended` is nullable sees no gap. That is the shape this row is for.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-undecided-contention-check-is-not-a-quiet-one",
  what:
    "a shared-database inspection that could not decide is INCONCLUSIVE rather than PROCEED, so "
    + "the run does not pass through the uncertainty it was told to stop for",
  file: "src/acceptance/disposable-realm.ts",
  find: '  if (observation.contended === null) return "INCONCLUSIVE";\n',
  replace: "",
  killedBy: [
    "tests/unit/the-two-preconditions-the-list-names.test.ts::is inconclusive when the inspection ran and could not decide",
  ],
};
export default c;
