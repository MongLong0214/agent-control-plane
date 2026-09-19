// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const restorationHermesProofIsAdmissible = {
  "id": "restoration-hermes-proof-is-admissible",
  "what": "CEO restoration accepts the authenticated Hermes proof",
  "file": "src/session/binding-registry.ts",
  "find": "input.role !== Role.CEO || input.projectId || input.runId || input.taskId ||\n        target?.protocolVersion !== HERMES_TARGET_BIND_PROTOCOL || target.claimed.executorKind !== \"hermes\"",
  "replace": "(input.role !== Role.CEO || input.projectId || input.runId || input.taskId ||\n        target?.protocolVersion !== HERMES_TARGET_BIND_PROTOCOL || target.claimed.executorKind !== \"hermes\") || true",
  "killedBy": [
    "tests/unit/ceo-same-actor-restore.test.ts::attaches the first authenticated target"
  ]
};

export default restorationHermesProofIsAdmissible;
