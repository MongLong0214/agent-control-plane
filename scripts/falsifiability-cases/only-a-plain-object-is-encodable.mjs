/**
 * #833 — a Date, Map, Set or class instance is refused rather than silently encoded as {}.
 *
 * A pure guard in one of the small excluded files: no fixture, so its operands are
 * answerable with a row rather than owed. The anchor is the operand rather than its line,
 * because the census credits every operand inside an anchor.
 */
const onlyAPlainObjectIsEncodable = {
  id: 'only-a-plain-object-is-encodable',
  what: 'a Date, Map, Set or class instance is refused rather than silently encoded as {}',
  file: 'src/core/digest.ts',
  find: 'proto !== Object.prototype',
  replace: 'true',
  killedBy: [
    'tests/unit/the-small-guards-have-witnesses.test.ts::canonicalJson allows a null-prototype object and refuses a class instance',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default onlyAPlainObjectIsEncodable;
