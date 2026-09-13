/**
 * #885 — a change to the test that kills a row selects that row.
 *
 * This is the first of the two operands that make the closure wider than the proposal it replaced.
 * `row.file` alone was refused because a row stops being killed for reasons that never touch the
 * mutated module, and the plainest of those is the witness itself changing: retitle the test and
 * `killedBy` no longer names anything the sweep will run, which the harness reports as a dead
 * selector — but only if the row is in scope at all.
 *
 * Removing this operand is not visible in the shape of the answer. The function still returns
 * `SELECTED`, still with real reasons for the rows it keeps. The test-only change simply comes
 * back empty, which reads as "this change affects no guard" rather than as "the selector cannot
 * see this kind of change".
 *
 *
 * Measured with `--only` before this prose was written: `killed`. The file's eleven cases pass
 * unmutated, which is the baseline that kill rests on — the harness's own baseline artifact is a
 * CI result set and was not supplied to these local runs, so it says so rather than assuming it.
 */
const aWitnessThatChangedSelectsItsOwnRow = {
  id: "a-witness-that-changed-selects-its-own-row",
  what: "a change to the test named in killedBy selects the row that test is the witness for",
  file: "scripts/lib/affected-closure.mjs",
  find: '      witnesses.some((file) => changed.has(file)) ? "its witness test changed" : null,\n',
  replace: "      null,\n",
  killedBy: [
    "tests/unit/the-affected-closure-selects-what-a-change-can-break.test.ts::2 — a change to the witness test alone selects its row; the refused proposal selects nothing",
  ],
};

export default aWitnessThatChangedSelectsItsOwnRow;
