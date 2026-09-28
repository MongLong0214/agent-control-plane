/**
 * The executing image is observed, never required (2026-09-27). This row replaced
 * `an-image-scan-that-did-not-run-is-not-an-image-conflict`, which pinned the opposite: that a scan
 * which could not run refused as `PROBE_FAILED` rather than `CONFLICT`. Both refusals existed only
 * to feed a comparison against a configured version, realpath and sha256, and that comparison is
 * withdrawn — so the old row's mutation (neutering `isExecutingImageProbeFailure`) no longer says
 * anything about admission. Its one remaining reader, the observation in `#mutate`, maps a probe
 * failure and a `null` resolution to the same recorded "no image" either way.
 *
 * The contract now lives where the refusal used to be: right after the image is resolved in
 * `verifyClaudeIdentity`. The mutant puts the probe-failure refusal back there. It compiles —
 * `isExecutingImageProbeFailure`, `deny` and `ReasonCode` are all in scope at that line — and a
 * claimant whose scan timed out, but whose entry entitles it, is then refused `PROBE_FAILED`
 * instead of admitted, which the named test asserts against. Derived on 2026-09-27 by applying
 * this exact insertion by hand before commit: `tsc --noEmit` exit 0, and the named test failed
 * with `{"allowed":false,"reasonCode":"PROBE_FAILED",…}: expected false to be true`.
 *
 * The `null` shape — a scan that ran and found no usable image, which is what a session whose
 * build the updater deleted resolves to — has its own test beside this one and no row here.
 */
const anImageScanThatDidNotRunDoesNotRefuseAnEntitledClaim = {
  id: "an-image-scan-that-did-not-run-does-not-refuse-an-entitled-claim",
  what: "an executing image the scan could not run on does not refuse a claim its entry entitles",
  file: "src/registry/canonical-self-claim.ts",
  find: "  const image = imageInspector.resolve(identity.pid);\n",
  replace:
    "  const image = imageInspector.resolve(identity.pid);\n" +
    '  if (isExecutingImageProbeFailure(image)) return deny(ReasonCode.PROBE_FAILED, "the executing-image scan did not run", { pid: identity.pid });\n',
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::clause 2 — an executing image the scan could not run on does not refuse a claim its entry entitles",
  ],
};

export default anImageScanThatDidNotRunDoesNotRefuseAnEntitledClaim;
