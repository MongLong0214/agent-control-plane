// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-grant-exact-receipt",
  "what": "an exact unexpired owner receipt grants scoped authority",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!r.approved || r.operation !== CTO_BINDING_DELEGATE_OPERATION ||\n        r.parameterDigest !== digestOf(s) || r.runId !== null || r.candidateSnapshotDigest !== null ||\n        Date.parse(s.expiresAt) <= this.clock.now().getTime()",
  "replace": "(!r.approved || r.operation !== CTO_BINDING_DELEGATE_OPERATION ||\n        r.parameterDigest !== digestOf(s) || r.runId !== null || r.candidateSnapshotDigest !== null ||\n        Date.parse(s.expiresAt) <= this.clock.now().getTime()) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::requires an admitted explicit owner decision"
  ]
};
