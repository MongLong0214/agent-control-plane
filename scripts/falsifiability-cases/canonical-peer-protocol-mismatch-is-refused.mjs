// Adopted 2026-09-20 from an orphaned worktree, with the witness narrowed before adoption.
//
// The `killedBy` named a file and no test. That is not vacuous - `vitestArgsFor`
// (verify-guards-are-falsifiable.mjs:82-95) runs the whole file with no `-t` when no entry is
// named, so the mutation still had to break something in it. It is weaker: any failure in a
// 1,300-line file counted as this mutation's death, which is a witness that cannot say *which*
// behaviour died. 275 of 275 other entries carry the name. This one now names the case that
// exercises exactly this mismatch.
// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const canonicalPeerProtocolMismatchIsRefused = {
  "id": "canonical-peer-protocol-mismatch-is-refused",
  "what": "a connected peer protocol mismatch is refused",
  "file": "src/registry/canonical-self-claim.ts",
  "find": "peer && peer.protocolVersion !== peer.expectedProtocolVersion",
  "replace": "peer && peer.protocolVersion === peer.expectedProtocolVersion",
  "killedBy": [
    "tests/unit/canonical-self-claim.test.ts::clause 2 — peer protocol version must match the deployment's expectation"
  ]
};

export default canonicalPeerProtocolMismatchIsRefused;
