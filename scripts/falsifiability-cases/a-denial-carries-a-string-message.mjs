/**
 * #833 — a denial carries a string message.
 *
 * The message is what reaches a person. Accepting a non-string one means the value that ends up
 * rendered to an owner is whatever `String()` makes of it, decided at the point of display rather
 * than at the boundary that was supposed to validate it.
 */
const aDenialCarriesAStringMessage = {
  id: "a-denial-carries-a-string-message",
  what: "a denial whose message is not a string is refused",
  file: "src/core/errors.ts",
  find: "typeof candidate.message === \"string\" &&",
  replace: "true &&",
  killedBy: ["tests/unit/the-refusal-primitive-refuses.test.ts::refuses a message that is not a string"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDenialCarriesAStringMessage;
