// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const durableGrantRemainsReadable = {
  "id": "durable-grant-remains-readable",
  "what": "a receipt-bound grant remains reconstructible",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "grants.has(g.delegationId) || g.delegationId !== durableId(r) ||\n              g.scope.revokePolicy !== \"owner-or-ceo-loss\" || r.operation !== CTO_BINDING_DELEGATE_OPERATION ||\n              !r.approved || r.runId !== null || r.candidateSnapshotDigest !== null ||\n              r.parameterDigest !== digestOf(g.scope) || !prior || prior.eventId >= row.event_id ||\n              prior.evidence.candidateSnapshotDigest !== null || prior.evidence.runId !== null ||\n              prior.evidence.operation !== r.operation || prior.evidence.approved !== true ||\n              prior.evidence.channel !== r.channel || prior.evidence.actor !== r.actor",
  "replace": "grants.has(g.delegationId) || g.delegationId !== durableId(r) ||\n              g.scope.revokePolicy !== \"owner-or-ceo-loss\" || r.operation !== CTO_BINDING_DELEGATE_OPERATION ||\n              !r.approved || r.runId !== null || r.candidateSnapshotDigest !== null ||\n              r.parameterDigest !== digestOf(g.scope) || !prior || prior.eventId >= row.event_id ||\n              prior.evidence.candidateSnapshotDigest !== null || prior.evidence.runId !== null ||\n              prior.evidence.operation !== r.operation || prior.evidence.approved !== true ||\n              prior.evidence.channel !== r.channel || prior.evidence.actor === r.actor",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::reconstructs only an explicitly durable"
  ]
};

export default durableGrantRemainsReadable;
