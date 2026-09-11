/**
 * The second consumer of the same scan, and the same distinction (#834).
 *
 * On Darwin `lsof` is the only channel to the executing image. A scan that times out or cannot
 * run resolves every image to nothing, and that used to arrive as `CONFLICT` — the daemon telling
 * the operator the running binary was not the expected one when nothing had looked at it. This
 * deployment already has a row for the shape that produces it: the launchd PATH row, whose own
 * comment records that dropping `/usr/sbin` "refuses a genuine canonical self-claim as CONFLICT".
 *
 * With the discriminator neutered, a probe failure is indistinguishable from a resolved image
 * again and falls into the version comparison below.
 */
const anImageScanThatDidNotRunIsNotAnImageConflict = {
  id: "an-image-scan-that-did-not-run-is-not-an-image-conflict",
  what: "an executing-image scan that could not run refuses as a failed probe, never as a conflicting image",
  file: "src/registry/canonical-self-claim.ts",
  find: '): resolution is ExecutingImageProbeFailure => resolution !== null && "probeFailure" in resolution;',
  replace: "): resolution is ExecutingImageProbeFailure => false;",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 2 — an executing image the scan never reached refuses as a failed probe, not as a conflict",
  ],
};

export default anImageScanThatDidNotRunIsNotAnImageConflict;
