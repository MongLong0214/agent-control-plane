/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-telegram-secret-length-is-compared-before-its-bytes",
  what: "a wrong-length secret is refused rather than throwing, because timingSafeEqual rejects mismatched lengths by exception",
  file: "src/ingress/telegram.ts",
  find: "a.length === b.length &&",
  replace: "true &&",
  killedBy: ["tests/unit/a-telegram-update-states-its-sender-and-chat.test.ts::refuses a secret of the wrong length without throwing"],
};
export default c;
