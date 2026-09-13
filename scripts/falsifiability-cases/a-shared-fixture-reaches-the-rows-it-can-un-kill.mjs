/**
 * #885 — a change to a helper a witness inherits selects the rows that witness kills.
 *
 * The second operand the refused proposal was missing, and the one with the widest reach in this
 * repository: `tests/helpers/fixtures.ts` is imported by 33 test files, so one edit to it can
 * un-kill rows whose mutated modules were never touched. The transitive walk is what makes that
 * visible — the fixture is two hops from the witness in the case this row's test builds, and a
 * one-hop check would miss it.
 *
 * Removing the operand leaves a selection that is still correct for everything it does select. The
 * failure is entirely in what it stops selecting, and it presents as a smaller, faster, apparently
 * healthy pull-request sweep. That is the shape #885 is about: a reduction in what CI proves,
 * arrived at without anyone deciding it.
 *
 *
 * Measured with `--only` before this prose was written: `killed`. The file's eleven cases pass
 * unmutated, which is the baseline that kill rests on — the harness's own baseline artifact is a
 * CI result set and was not supplied to these local runs, so it says so rather than assuming it.
 */
const aSharedFixtureReachesTheRowsItCanUnKill = {
  id: "a-shared-fixture-reaches-the-rows-it-can-un-kill",
  what:
    "a change to a helper the witness test imports, at any depth, selects the rows that witness "
    + "is responsible for killing",
  file: "scripts/lib/affected-closure.mjs",
  find:
    '      witnesses.some((file) => reachesAChange(file, changed, imports)) ? "its witness imports a changed file" : null,\n',
  replace: "      null,\n",
  killedBy: [
    "tests/unit/the-affected-closure-selects-what-a-change-can-break.test.ts::3 — a change to a shared helper two hops from the witness selects the row it can un-kill",
  ],
};

export default aSharedFixtureReachesTheRowsItCanUnKill;
