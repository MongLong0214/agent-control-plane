/**
 * R1041-02, round 2: Buzz records its answer with `repliedAt` and has no reservation step, so the
 * exclusion has to hold at the resolution itself.
 */
const aBuzzAnswerExcludesAnOwedReply = {
  id: "a-buzz-answer-excludes-an-owed-reply",
  what: "an answer cannot be recorded for a message the owner-reply outbox already owes",
  file: "src/ingress/ingress-guard.ts",
  find: "      // this directly, without a reservation step to refuse first.\n      const owedBy = ownerReplyOwing(this.db, { channel, nonce });",
  replace: "      // this directly, without a reservation step to refuse first.\n      const owedBy = null as string | null;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 refuses to record a Buzz answer for a message a receipt already queued a reply for",
  ],
};

export default aBuzzAnswerExcludesAnOwedReply;
