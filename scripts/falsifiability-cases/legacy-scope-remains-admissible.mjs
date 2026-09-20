// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const legacyScopeRemainsAdmissible = {
  "id": "legacy-scope-remains-admissible",
  "what": "scope refinement must admit a legacy owner grant",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "s.revokePolicy !== \"owner-or-ceo-loss\" || !!s.ceoActorId",
  "replace": "s.revokePolicy !== \"owner-or-ceo-loss\" && !!s.ceoActorId",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::requires an admitted explicit owner decision"
  ]
};

export default legacyScopeRemainsAdmissible;
