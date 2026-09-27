/**
 * #954 — the preserved-observation row names its key so the audit log will actually store it.
 *
 * `AUDIT_EVIDENCE_KEYS` contains `error` and does not contain `collectorError`. An allowlisted
 * value goes through `redact` with a 2000-character budget; an unknown one must be
 * identifier-shaped and at most `MAX_UNKNOWN_AUDIT_STRING` (200) characters or
 * `isAllowlistedAuditEvidence` returns false and `AuditLog.record` refuses the WHOLE evidence,
 * storing `reason_code=TRUSTED_CREDENTIAL_LEAK_BLOCKED` and `{"auditEvidenceRejected":true}`.
 *
 * Measured: the 41-character sentence this unit replaced was admitted under the old key, and the
 * new sentence naming an absolute versioned pin is over 200 and is not. So under the old key the
 * change swapped a wrong sentence for a wrong verdict — a credential leak that never happened —
 * and dropped the cause from the row entirely.
 *
 * The mutation restores the old key. It typechecks, and the object handed to `record` is
 * unchanged in every other respect, which is exactly why an assertion on that object cannot
 * catch it: the refusal happens inside `record`. Only a read of the stored row can.
 *
 * The telemetry `dims` sibling deliberately keeps `collectorError` and has no row here: that
 * path calls `redact` only, with no allowlist and no length refusal, so there is no guard to
 * falsify there.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-preserved-observation-uses-the-allowlisted-error-key",
  what:
    "the preserved-observation CAPACITY_PROBE evidence names the collector sentence under the "
    + "allowlisted `error` key, so a sentence long enough to name a pin is stored rather than "
    + "refused as an unknown free-form field",
  file: "src/capacity/capacity-monitor.ts",
  find: "              error: reading.error ?? null,\n",
  replace: "              collectorError: reading.error ?? null,\n",
  killedBy: [
    "tests/unit/continuity-hardening.test.ts::#954: a preserved observation records the collector's sentence at the length a real pin gives it",
  ],
};
export default c;
