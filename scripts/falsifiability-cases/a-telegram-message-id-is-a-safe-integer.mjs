/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-telegram-message-id-is-a-safe-integer",
  what: "a message id past the safe-integer range is refused, because the nonce is derived from it",
  file: "src/ingress/telegram.ts",
  find: "!Number.isSafeInteger(message.message_id) ||",
  replace: "false ||",
  killedBy: ["tests/unit/a-telegram-update-states-its-sender-and-chat.test.ts::refuses a message id that is not a safe integer"],
};
export default c;
