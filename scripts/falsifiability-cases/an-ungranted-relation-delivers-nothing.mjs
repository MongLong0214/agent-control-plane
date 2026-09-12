/**
 * #674. The relation's answer is the admission, not a step on the way to it.
 *
 * `#admitRelation` returns the authority's `Decision` so that a refused relation refuses the
 * envelope. An implementation that consulted the authority and then admitted anyway would look
 * identical in every log that records *that* the authority was asked — the spy in the killing
 * test records the call either way — and would grant every role holder every target.
 *
 * Mutating the return so the call happens and its verdict is discarded is that implementation
 * exactly. It is killed by the case whose authority grants the sender's role no targets at all:
 * the relation is asked, answers no, and the envelope must not be admitted.
 */
const anUngrantedRelationDeliversNothing = {
  id: "an-ungranted-relation-delivers-nothing",
  what: "a relation the authority refuses refuses the envelope",
  file: "src/ingress/buzz-message.ts",
  find: "    return this.collaboration.admitRelation({ senderRoleKey, targetRoleKey: target.roleKey });\n",
  replace:
    "    this.collaboration.admitRelation({ senderRoleKey, targetRoleKey: target.roleKey });\n    return allow(ReasonCode.OK, null);\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::refuses a role sender whose relation to the addressed role is not granted",
  ],
};

export default anUngrantedRelationDeliversNothing;
