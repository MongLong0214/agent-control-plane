/**
 * #833 — the guard answers false for null instead of dereferencing it.
 *
 * `typeof null === "object"`, so this operand is not redundant with the object test beside it:
 * remove it and `candidate.reasonCode` reads a property of `null`, which **throws** rather than
 * returning false.
 *
 * A guard that throws is not a guard that refuses. Every caller in this repository uses
 * `isAcpError` in a boolean position — `isAcpError(error) && error.reasonCode` — so a throw here
 * does not deny the value, it takes out the code asking the question.
 */
const aDenialGuardRefusesNullRatherThanThrowing = {
  id: "a-denial-guard-refuses-null-rather-than-throwing",
  what: "null is refused rather than dereferenced, so the guard answers false where every caller uses it in a boolean position",
  file: "src/core/errors.ts",
  find: " || value === null",
  replace: "",
  killedBy: ["tests/unit/the-refusal-primitive-refuses.test.ts::refuses null without throwing"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDenialGuardRefusesNullRatherThanThrowing;
