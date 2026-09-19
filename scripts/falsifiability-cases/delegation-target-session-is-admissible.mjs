// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationTargetSessionIsAdmissible = {
  "id": "delegation-target-session-is-admissible",
  "what": "the configured matching session reaches target verification",
  "file": "src/daemon/cto-binding-runtime.ts",
  "find": "!target || !session || session.provider !== target.provider || session.incarnation !== target.incarnation",
  "replace": "(!target || !session || session.provider !== target.provider || session.incarnation !== target.incarnation) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::Claude target pins.*success"
  ]
};

export default delegationTargetSessionIsAdmissible;
