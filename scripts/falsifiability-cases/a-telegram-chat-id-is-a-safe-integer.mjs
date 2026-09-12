/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-telegram-chat-id-is-a-safe-integer",
  what: "a chat id that is not a safe integer is refused, because that id becomes the conversation the allowlist is matched against",
  file: "src/ingress/telegram.ts",
  find: "!Number.isSafeInteger(message.chat.id)",
  replace: "false",
  killedBy: ["tests/unit/a-telegram-update-states-its-sender-and-chat.test.ts::refuses a chat id that is not a safe integer"],
};
export default c;
