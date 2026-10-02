/**
 * R1041-02, round 2: the reverse order. Reserving the CEO's answer for a message a receipt already
 * queued a reply for would leave both standing.
 */
const anAnswerReservationExcludesAnOwedReply = {
  id: "an-answer-reservation-excludes-an-owed-reply",
  what: "the CEO's answer cannot be reserved for a message the owner-reply outbox already owes",
  file: "src/ingress/ingress-guard.ts",
  find: "      if (carriesTheAnswer(result)) {",
  replace: "      if (false as boolean) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 refuses to reserve the CEO's answer for a message a receipt already queued a reply for",
  ],
};

export default anAnswerReservationExcludesAnOwedReply;
