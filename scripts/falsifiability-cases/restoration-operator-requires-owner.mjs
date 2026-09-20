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
const restorationOperatorRequiresOwner = {
  "id": "restoration-operator-requires-owner",
  "what": "a non-owner operator cannot restore existing CEO authority",
  "file": "src/daemon/agentcpd.ts",
  "find": "cp.bindings.history(Role.CEO).length > 0 &&\n          !cp.ownerAuthority.isAllowedActor(\"cli\", operatorActor)",
  "replace": "cp.bindings.history(Role.CEO).length > 0 &&\n          cp.ownerAuthority.isAllowedActor(\"cli\", operatorActor)",
  "killedBy": [
    "tests/scenarios/hermes-bootstrap-owner-boundary.test.ts::'non-owner bob' is checked before caller-selected executables run"
  ]
};

export default restorationOperatorRequiresOwner;
