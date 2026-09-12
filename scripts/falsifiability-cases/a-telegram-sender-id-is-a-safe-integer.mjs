/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-telegram-sender-id-is-a-safe-integer",
  what: "a sender id that is not a safe integer is refused, because that id becomes the actor the allowlist is matched against",
  file: "src/ingress/telegram.ts",
  find: "!Number.isSafeInteger(message.from.id) ||",
  replace: "false ||",
  killedBy: ["tests/unit/a-telegram-update-states-its-sender-and-chat.test.ts::refuses a sender id that is not a safe integer"],
};
export default c;
