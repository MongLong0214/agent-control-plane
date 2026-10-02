/**
 * R1041-01: a Telegram reply threads under the owner's own message; without its id the address is
 * incomplete.
 */
const aTelegramReplyNeedsTheMessageItAnswers = {
  id: "a-telegram-reply-needs-the-message-it-answers",
  what: "a Telegram reply is refused when the admitted payload has no message id",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "    const messageId = positiveIdOf(payload[\"messageId\"]);",
  replace: "    const messageId = positiveIdOf(payload[\"messageId\"]) ?? 1;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::leaves the turn unsettled for R1041-01 a Telegram message with no message id to reply to",
  ],
};

export default aTelegramReplyNeedsTheMessageItAnswers;
