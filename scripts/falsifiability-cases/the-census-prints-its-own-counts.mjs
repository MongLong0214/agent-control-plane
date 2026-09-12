/**
 * #833 — the census's operand split is derived from the lists and has to reconcile with them.
 *
 * The mutation freezes the excluded-operand total at a literal. That is the state before this
 * change, except the literal lived in two header comments rather than in the script: it said
 * 89 files, then 88, then 87 as files left the list, and three branches each decrementing it
 * from their own base made a rebase conflict on the number instead of on any logic.
 *
 * A frozen literal equal to today's value is undetectable on the commit that writes it, so the
 * guard is not "print a number" but "the parts must reconcile with the population they came
 * from": `selected + excluded` against the operands counted across every deciding file. The
 * mutation breaks that sum, and the script refuses rather than printing a report nobody can
 * check.
 *
 * Killed by the reconciliation case, which runs the census and reads its CENSUS line, and the
 * kill is the *test's assertion* — `selected + excluded` against the whole, read off a
 * successfully printed line. An earlier version of this docstring credited the product's refusal
 * instead, and a merge-gate review showed that is not the mechanism: with the refusal block
 * deleted, this mutation is still killed by that assertion. Claiming otherwise is the unearned
 * attribution `splitKilledBy` in `verify-guards-are-falsifiable.mjs` exists to find.
 *
 * The refusal has its own row now — `the-reconciliation-refusal-is-witnessed` — because nothing
 * here reaches it. `selected` and `excluded` are complementary filters over one `candidates`
 * list, so the sum is a tautology over any repository state and the branch fires only for a
 * census that has stopped deriving a number.
 *
 * An earlier version of that case copied the census into `scripts/` and froze a number in the
 * copy, and this docstring then claimed a relocated fixture was impossible: the copy had to sit
 * one level below the repository root (`ROOT` is `new URL("..", import.meta.url)`) and `scripts/`
 * was said to be the only such place where both `./lib/*` and `typescript` resolve. **That was
 * wrong**, and `tests/process/the-refusal-operand-census-derives-subjects.test.ts` already
 * contained the counterexample: a `mkdtempSync` root with a stubbed `scripts/lib`, a symlinked
 * `node_modules`, and the census copied in. The real defect in the `scripts/` copy was the race
 * against `every-script-has-a-plausible-caller.test.ts`, which enumerates direct children of
 * `scripts/`; the fix was the temporary root, not the removal of the fixture.
 */
const theCensusPrintsItsOwnCounts = {
  id: "the-census-prints-its-own-counts",
  what: "the operand totals the census reports are summed from the lists it loaded and must reconcile with the whole population, so neither side can be frozen at a literal",
  file: "scripts/verify-refusal-operands-are-watched.mjs",
  // A *wrong* literal, deliberately. One equal to today's value is
  // indistinguishable from a derived number on the commit that writes it, which
  // is how the header prose survived three removals looking plausible — so the
  // mutation has to break the arithmetic for the refusal to be reachable at all.
  find: "const excludedOperands = excluded.reduce((sum, { operands }) => sum + operands.size, 0);",
  replace: "const excludedOperands = 1;",
  killedBy: [
    "tests/unit/the-census-prints-its-own-counts.test.ts::reconciles its split with the population it came from, or exits non-zero",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theCensusPrintsItsOwnCounts;
