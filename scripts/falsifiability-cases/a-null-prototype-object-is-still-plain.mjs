/**
 * #833 — a null-prototype object is canonically encodable, and only this operand keeps the refusal off it.
 *
 * A pure guard in one of the small excluded files: no fixture, so its operands are
 * answerable with a row rather than owed. The anchor is the operand rather than its line,
 * because the census credits every operand inside an anchor.
 */
const aNullPrototypeObjectIsStillPlain = {
  id: 'a-null-prototype-object-is-still-plain',
  what: 'a null-prototype object is canonically encodable, and only this operand keeps the refusal off it',
  file: 'src/core/digest.ts',
  find: 'proto !== null',
  replace: 'true',
  killedBy: [
    'tests/unit/the-small-guards-have-witnesses.test.ts::canonicalJson allows a null-prototype object and refuses a class instance',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aNullPrototypeObjectIsStillPlain;
