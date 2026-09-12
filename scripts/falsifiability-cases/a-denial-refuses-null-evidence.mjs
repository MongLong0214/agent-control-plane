/**
 * #833 — null evidence is refused, and only this operand refuses it.
 *
 * `typeof null === "object"` passes the check immediately above, so this is not a second spelling
 * of it. Without this operand a denial can carry `evidence: null`, and then every caller reading a
 * field off it throws — the same shape as the null guard at the top of this function, one layer in.
 */
const aDenialRefusesNullEvidence = {
  id: "a-denial-refuses-null-evidence",
  what: "null evidence is refused, which the typeof check above admits because typeof null is object",
  file: "src/core/errors.ts",
  find: "candidate.evidence !== null",
  replace: "true",
  killedBy: ["tests/unit/the-refusal-primitive-refuses.test.ts::refuses null evidence, which the typeof check admits"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDenialRefusesNullEvidence;
