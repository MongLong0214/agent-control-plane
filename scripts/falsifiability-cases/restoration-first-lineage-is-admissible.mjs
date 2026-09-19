// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "restoration-first-lineage-is-admissible",
  "what": "the first authenticated target can establish the existing actor lineage",
  "file": "src/session/binding-registry.ts",
  "find": "existing && (existing.executor_kind !== target.claimed.executorKind ||\n        existing.target_locator_digest !== target.claimed.targetLocatorDigest)",
  "replace": "(existing && (existing.executor_kind !== target.claimed.executorKind ||\n        existing.target_locator_digest !== target.claimed.targetLocatorDigest)) || true",
  "killedBy": [
    "tests/unit/ceo-same-actor-restore.test.ts::attaches the first authenticated target"
  ]
};
