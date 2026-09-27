/**
 * The other half of what `an-image-scan-that-did-not-run-is-not-an-image-conflict` used to watch.
 * That row neutered the whole `isExecutingImageProbeFailure` discriminator and was killed by the
 * refusal it produced. The refusal is withdrawn (2026-09-27; see
 * `an-image-scan-that-did-not-run-does-not-refuse-an-entitled-claim`), and the discriminator's one
 * remaining reader is the observation in `#mutate`, which folds a probe failure into "no image".
 *
 * So what the discriminator still decides is whether a resolved image is *recorded*. With its
 * `"probeFailure" in resolution` operand removed it answers true for every non-null resolution,
 * every real image reads as a scan that never ran, and every receipt says `executorImageVersion:
 * null` — the admission is unchanged and the record is silently empty. Measured by hand on
 * 2026-09-27 before commit: the mutant compiles (`tsc --noEmit` exit 0) and fails the named test
 * and the multi-build test beside it, both of which assert the version the claimant was running.
 *
 * The `resolution !== null` operand beside it cannot carry a row: removing it is TS18047 at the
 * `in` (measured, exit 2). It is answered in `refusal-operands-unanswered.mjs` as TypeScript-
 * enforced, which is why `find` stops short of it.
 */
const aResolvedImageIsRecordedNotFoldedIntoNoImage = {
  id: "a-resolved-image-is-recorded-not-folded-into-no-image",
  what: "an executing image the scan resolved is recorded on the receipt, never folded into a scan that did not run",
  file: "src/registry/canonical-self-claim.ts",
  find: ' && "probeFailure" in resolution;',
  replace: ";",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::claims the canonical session in one atomic mutation, writing exactly one row to each of the five tables",
  ],
};

export default aResolvedImageIsRecordedNotFoldedIntoNoImage;
