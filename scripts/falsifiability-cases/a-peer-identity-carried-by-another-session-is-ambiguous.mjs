/**
 * #1044. A Buzz channel identity another session row carries — a stopped one keeps the column —
 * may have signed any event that verifies under it, and nothing in the event says which holder did.
 * This is the identity's own history, and it is what makes a same-key rotation onto a new runtime
 * refuse every event signed with that key. The mutation disables it; the killing row's fresh event
 * after a same-key rotation is then admitted.
 */
const aPeerIdentityCarriedByAnotherSessionIsAmbiguous = {
  id: "a-peer-identity-carried-by-another-session-is-ambiguous",
  what: "a CEO channel identity another session carries is not this generation's alone",
  file: "src/daemon/agentcpd.ts",
  find: "      (cp.db.get<{ carried: number }>(\n        `SELECT EXISTS (SELECT 1 FROM sessions WHERE buzz_actor_id = ? AND session_id <> ?) AS carried`,\n        [channelIdentity, ceo.sessionId],\n      )?.carried !== 0 ||\n",
  replace: "      (cp.db.get<{ carried: number }>(\n        `SELECT EXISTS (SELECT 1 FROM sessions WHERE buzz_actor_id = ? AND session_id <> ? AND 0) AS carried`,\n        [channelIdentity, ceo.sessionId],\n      )?.carried !== 0 ||\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses every event signed with a reused key after a same-key rotation, and admits one from a fresh key",
  ],
};

export default aPeerIdentityCarriedByAnotherSessionIsAmbiguous;
