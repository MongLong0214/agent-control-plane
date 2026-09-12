/**
 * #833 — a denial states its reason code as a string.
 *
 * The mutation neuters the check, so a denial whose `reasonCode` is a number is accepted. Reason
 * codes are the repository's refusal vocabulary and are compared as strings everywhere; a numeric
 * one matches no `ReasonCode` and every comparison against it silently fails to match, which
 * reads as "a different refusal" rather than as a malformed one.
 *
 * Neutered to `true &&` rather than deleted, so the mutant keeps compiling — `candidate` stays
 * used and the boolean chain keeps its shape.
 */
const aDenialNamesItsReasonCodeAsAString = {
  id: "a-denial-names-its-reason-code-as-a-string",
  what: "a denial whose reason code is not a string is refused",
  file: "src/core/errors.ts",
  find: "typeof candidate.reasonCode === \"string\" &&",
  replace: "true &&",
  killedBy: ["tests/unit/the-refusal-primitive-refuses.test.ts::refuses a reason code that is not a string"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDenialNamesItsReasonCodeAsAString;
