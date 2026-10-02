/**
 * R1041-01: the chat comes from the admitted payload or nowhere. A claim digest is not a destination,
 * and a Telegram message whose payload names no chat has no address.
 */
const aTelegramReplyNeedsItsChat = {
  id: "a-telegram-reply-needs-its-chat",
  what: "a Telegram reply is refused when the admitted payload names no chat",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "    const chat = textOf(payload[\"chatId\"]);",
  replace: "    const chat = textOf(payload[\"chatId\"]) ?? \"unaddressed\";",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::leaves the turn unsettled for R1041-01 a Telegram message whose admitted payload names no chat",
  ],
};

export default aTelegramReplyNeedsItsChat;
