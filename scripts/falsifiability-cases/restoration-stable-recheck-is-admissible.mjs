// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const restorationStableRecheckIsAdmissible = {
  "id": "restoration-stable-recheck-is-admissible",
  "what": "restoration with stable generation and target survives the final recheck",
  "file": "src/session/binding-registry.ts",
  "find": "rechecked.value !== provisionalActorId || this.nextGeneration(roleKey) !== generation ||\n            this.active(roleKey) || current?.incarnation !== session.incarnation",
  "replace": "rechecked.value !== provisionalActorId || this.nextGeneration(roleKey) !== generation ||\n            this.active(roleKey) || current?.incarnation === session.incarnation",
  "killedBy": [
    "tests/unit/ceo-same-actor-restore.test.ts::attaches the first authenticated target"
  ]
};

export default restorationStableRecheckIsAdmissible;
