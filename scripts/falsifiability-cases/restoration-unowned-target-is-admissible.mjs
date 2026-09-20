// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const restorationUnownedTargetIsAdmissible = {
  "id": "restoration-unowned-target-is-admissible",
  "what": "an unowned target can attach to the restored actor",
  "file": "src/session/binding-registry.ts",
  "find": "owner.value !== null && owner.value !== restore.actorId",
  "replace": "owner.value === null && owner.value !== restore.actorId",
  "killedBy": [
    "tests/unit/ceo-same-actor-restore.test.ts::attaches the first authenticated target"
  ]
};

export default restorationUnownedTargetIsAdmissible;
