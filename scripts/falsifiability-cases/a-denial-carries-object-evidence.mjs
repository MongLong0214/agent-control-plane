/**
 * #833 — a denial carries object evidence.
 *
 * Evidence is what a denial is read for: the fields that say *which* path, *which* value. Accepted
 * as a string, every caller indexing into it gets `undefined` per key, so a denial with no account
 * is indistinguishable from one whose account happens not to mention the field being asked about.
 */
const aDenialCarriesObjectEvidence = {
  id: "a-denial-carries-object-evidence",
  what: "a denial whose evidence is not an object is refused",
  file: "src/core/errors.ts",
  find: "typeof candidate.evidence === \"object\" &&",
  replace: "true &&",
  killedBy: ["tests/unit/the-refusal-primitive-refuses.test.ts::refuses evidence that is not an object"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDenialCarriesObjectEvidence;
