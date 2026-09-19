// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-revoke-exact-receipt",
  "what": "an exact admitted revocation receipt revokes the grant",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!r.approved || r.operation !== \"ctoBinding.revoke\" || r.runId !== null ||\n        r.candidateSnapshotDigest !== null || r.parameterDigest !== digestOf({ delegationId })",
  "replace": "(!r.approved || r.operation !== \"ctoBinding.revoke\" || r.runId !== null ||\n        r.candidateSnapshotDigest !== null || r.parameterDigest !== digestOf({ delegationId })) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::owner revocation invalidates cached retries"
  ]
};
