/**
 * #740: `recordQualityObservation` has no production caller yet, and the seam is kept anyway —
 * the two facts it records are required Gate A evidence, so deleting the writer would force the
 * facts out of the list and make `quality.complete` reachable without them. Coverage would rise
 * by lowering the requirement.
 *
 * What the seam must not become is a way to satisfy those facts by saying so. `OBSERVED` and
 * `NOT_OBSERVED` both raise a fact to covered, so an operator asserting "no rollback happened"
 * with nothing attached buys exactly what a post-merge receipt buys. Measured against `ff0afa3`
 * on a genuinely completed production run: two evidence-free operator assertions were accepted
 * and moved `requiredFactCoverage` from 0.25 to 0.5.
 *
 * `UNAVAILABLE` stays free, and that is the point of the asymmetry: it is the honest way to say
 * nothing was looked at, and it covers nothing.
 */
const qualityObservationMustNameItsEvidence = {
  id: "quality-observation-must-name-its-evidence",
  what: "#740: a quality observation that claims to have looked must name the evidence it read",
  file: "src/export/baseline-recorder.ts",
  find:
    '    if (payload.status !== "UNAVAILABLE" && payload.evidenceDigest == null) {\n' +
    '      return deny(ReasonCode.INVALID_ARGUMENT, "an observed quality fact must name the evidence it was read from", {\n' +
    "        runId,\n" +
    "        fact: payload.fact,\n" +
    "        status: payload.status,\n" +
    "      });\n" +
    "    }\n",
  replace: "",
  killedBy: [
    "tests/unit/baseline-export.test.ts::refuses a quality observation that names no evidence it was read from",
  ],
};

export default qualityObservationMustNameItsEvidence;
