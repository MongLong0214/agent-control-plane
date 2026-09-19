// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const restorationExactIncumbentIsAdmissible = {
  "id": "restoration-exact-incumbent-is-admissible",
  "what": "the exact revoked incumbent actor tuple can be restored",
  "file": "src/session/binding-registry.ts",
  "find": "!previous || previous.status !== \"REVOKED\" || previous.actor_id !== restore.actorId ||\n        previous.binding_generation !== restore.generation || previous.session_id !== restore.sessionId ||\n        previous.session_incarnation !== restore.incarnation || !actor || actor.kind !== Role.CEO ||\n        actor.retired_at !== null || actor.current_session_id !== restore.sessionId ||\n        actor.current_session_incarnation !== restore.incarnation",
  "replace": "(!previous || previous.status !== \"REVOKED\" || previous.actor_id !== restore.actorId ||\n        previous.binding_generation !== restore.generation || previous.session_id !== restore.sessionId ||\n        previous.session_incarnation !== restore.incarnation || !actor || actor.kind !== Role.CEO ||\n        actor.retired_at !== null || actor.current_session_id !== restore.sessionId ||\n        actor.current_session_incarnation !== restore.incarnation) || true",
  "killedBy": [
    "tests/unit/ceo-same-actor-restore.test.ts::attaches the first authenticated target"
  ]
};

export default restorationExactIncumbentIsAdmissible;
