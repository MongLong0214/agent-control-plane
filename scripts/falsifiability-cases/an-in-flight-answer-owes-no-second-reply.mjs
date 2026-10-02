/**
 * R1041-02: a CEO answer reserved for the transport belongs to the ingress reply lifecycle, sent or
 * not; a second copy queued beside an ambiguous send is a duplicate in waiting. The replacement keeps
 * `result` narrowed so the mutant compiles.
 */
const anInFlightAnswerOwesNoSecondReply = {
  id: "an-in-flight-answer-owes-no-second-reply",
  what: "a message with a CEO answer reserved for the transport is not owed another",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (result?.[\"turnAnswered\"] !== true) return false;",
  replace: "  if (result === null) return false;\n  if (true as boolean) return false;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 owes nothing new while a CEO answer for the message is still in the transport's hands",
  ],
};

export default anInFlightAnswerOwesNoSecondReply;
