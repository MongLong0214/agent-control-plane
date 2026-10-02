/**
 * #1044. A Buzz channel identity another session row carries — a stopped one keeps the column —
 * may have signed any event that verifies under it, and nothing in the event says which holder did.
 * This clause is what makes a same-key rotation onto a new runtime refuse every event signed with
 * that key. The mutation disables it alone; the killing row's fresh event after a same-key rotation
 * is then admitted.
 */
const aPeerIdentityCarriedByAnotherSessionIsAmbiguous = {
  id: "a-peer-identity-carried-by-another-session-is-ambiguous",
  what: "a CEO channel identity another session carries is not this generation's alone",
  file: "src/daemon/agentcpd.ts",
  find: "      (cp.db.get<{ reused: number }>(\n        `SELECT\n            EXISTS (SELECT 1 FROM sessions WHERE buzz_actor_id = ? AND session_id <> ?)\n         OR EXISTS (SELECT 1 FROM assignments\n                     WHERE role_key = ? AND binding_generation < ? AND session_id = ?)\n         OR EXISTS (SELECT 1 FROM audit_events\n                     WHERE kind = 'BINDING_RUNTIME_MOVED' AND role_key = ? AND session_id = ?\n                       AND at < ?) AS reused`,\n        [\n          channelIdentity, ceo.sessionId,\n          ceo.roleKey, ceo.bindingGeneration, ceo.sessionId,\n          ceo.roleKey, ceo.sessionId, ceo.createdAt,\n        ],\n      )?.reused ?? 1) !== 0;\n",
  replace: "      (cp.db.get<{ reused: number }>(\n        `SELECT\n            EXISTS (SELECT 1 FROM sessions WHERE buzz_actor_id = ? AND session_id <> ? AND 0)\n         OR EXISTS (SELECT 1 FROM assignments\n                     WHERE role_key = ? AND binding_generation < ? AND session_id = ?)\n         OR EXISTS (SELECT 1 FROM audit_events\n                     WHERE kind = 'BINDING_RUNTIME_MOVED' AND role_key = ? AND session_id = ?\n                       AND at < ?) AS reused`,\n        [\n          channelIdentity, ceo.sessionId,\n          ceo.roleKey, ceo.bindingGeneration, ceo.sessionId,\n          ceo.roleKey, ceo.sessionId, ceo.createdAt,\n        ],\n      )?.reused ?? 1) !== 0;\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses every event signed with a reused key after a same-key rotation, and admits one from a fresh key",
  ],
};

export default aPeerIdentityCarriedByAnotherSessionIsAmbiguous;
