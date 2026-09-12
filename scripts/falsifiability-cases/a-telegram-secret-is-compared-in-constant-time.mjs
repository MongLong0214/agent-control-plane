/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-telegram-secret-is-compared-in-constant-time",
  what: "a same-length secret whose bytes differ is refused, so length agreement alone does not authenticate",
  file: "src/ingress/telegram.ts",
  find: "timingSafeEqual(a, b)",
  replace: "true",
  killedBy: ["tests/unit/a-telegram-update-states-its-sender-and-chat.test.ts::refuses a secret of the right length whose bytes differ"],
};
export default c;
