/**
 * #740, the read half of `quality-observation-must-name-its-evidence`, and deliberately not
 * redundant with it.
 *
 * `baseline_records` is append-only and defended by triggers, so a digest-free row already in
 * the ledger — written before the recorder required evidence, or inserted around the recorder —
 * is read on every export forever. Coverage is decided here, at the read, so the digest is
 * required here too.
 *
 * Neither row can kill the other's test, which is why both exist: the write row refuses to
 * store an evidence-free claim, and this one refuses to count one that is already stored. Its
 * test inserts that row into `baseline_records` directly, so the recorder's refusal is not in
 * its path at all.
 */
const storedQualityObservationCoversOnlyWithEvidence = {
  id: "stored-quality-observation-covers-only-with-evidence",
  what: "#740: a stored quality observation covers its fact only if it names its evidence",
  file: "src/export/run-evidence.ts",
  find: '    return isDigest(observation["evidenceDigest"]);\n',
  replace: "    return true;\n",
  killedBy: [
    "tests/unit/baseline-export.test.ts::does not let a stored quality observation with a malformed nonempty evidence digest cover its fact",
  ],
};

export default storedQualityObservationCoversOnlyWithEvidence;
