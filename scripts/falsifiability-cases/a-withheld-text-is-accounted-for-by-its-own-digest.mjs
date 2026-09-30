/**
 * A withheld text is accounted for by the digest of that text, and by its length in the same bytes.
 *
 * A withheld text is content a reader of the repository cannot see, so the account of it is the
 * whole of what they get: the kind of text it was, how long it was, and a digest an operator holding
 * the raw capture can recompute. A digest of anything else -- the label, a constant, the request --
 * would look exactly as authoritative in the file and would tie the record to nothing, which is the
 * failure this record exists against: a number in a reading standing on its own word.
 *
 * The mutation digests the label instead of the text, which is the shape a copy-paste takes and
 * still produces 64 hex characters, so every check that only asks whether a digest is *shaped* like
 * one passes. The killing row recomputes the digest over the text's own UTF-8 bytes, and its length
 * over the same bytes, for the withheld system block and the withheld aside.
 */
const aWithheldTextIsAccountedForByItsOwnDigest = {
  id: "a-withheld-text-is-accounted-for-by-its-own-digest",
  what: "a withheld model-input text records the digest of that text, over the same bytes its length counts",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '    sha256: createHash("sha256").update(Buffer.from(entry.text, "utf8")).digest("hex"),\n',
  replace: '    sha256: createHash("sha256").update(Buffer.from(entry.from, "utf8")).digest("hex"),\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::keeps the texts its counts are read from, and withholds every other by kind, length and digest",
  ],
};

export default aWithheldTextIsAccountedForByItsOwnDigest;
