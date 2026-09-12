/**
 * #833 — a string of the wrong length or case is not a digest.
 *
 * A pure guard in one of the small excluded files: no fixture, so its operands are
 * answerable with a row rather than owed. The anchor is the operand rather than its line,
 * because the census credits every operand inside an anchor.
 */
const aDigestHasItsExactShape = {
  id: 'a-digest-has-its-exact-shape',
  what: 'a string of the wrong length or case is not a digest',
  file: 'src/core/digest.ts',
  find: '/^sha256:[0-9a-f]{64}$/.test(value)',
  replace: 'true',
  killedBy: [
    'tests/unit/the-small-guards-have-witnesses.test.ts::isDigest accepts one shape and refuses everything adjacent to it',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDigestHasItsExactShape;
