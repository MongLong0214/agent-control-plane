/**
 * A test that forges an id by substituting fixed characters is not always forging one.
 *
 * `refuses an event whose id is not the hash of what was signed` built its forgery as
 * `id.slice(0, -2) + "00"`. An event id is a hash, so one id in 256 already ends in `00` — and on
 * those runs the "forged" event **is** the original. The subscriber then admits it, correctly, and
 * the case fails claiming a forgery was accepted.
 *
 * Measured on CI at that rate, on a branch that does not touch this file: `expected [ { …(4) } ] to
 * deeply equal []`. Reproduced the arithmetic directly — 85 of 20,000 random 64-hex strings satisfy
 * `slice(0, -2) + "00" === original` (0.43%, against 1/256 = 0.39%).
 *
 * Flipping the last nibble differs in every case: 0 of 200,000 random ids came back unchanged, and
 * the result is still 64 lowercase hex characters so the shape checks upstream still see an id.
 *
 * The mutation restores the fixed substitution *in the one place the rule lives*. An earlier
 * version of this row reported SURVIVED because the property case carried its own copy of the
 * arithmetic — two authorities over one rule, so mutating the original left the duplicate
 * answering correctly. The helper is defined once now and both cases call it.
 *
 * It cannot be killed by a single run of the forgery case — that is the defect — so the killing
 * case asserts the *property*: the forgery differs from the original for every id, including one
 * already ending in the substituted characters.
 */
const aForgedIdIsAlwaysADifferentId = {
  id: "a-forged-id-is-always-a-different-id",
  what: "a forged event id differs from the original for every id, not for 255 out of 256",
  file: "tests/unit/buzz-mention-subscriber.test.ts",
  find: '    `${id.slice(0, -1)}${id.slice(-1) === "0" ? "1" : "0"}`;\n',
  replace: '    `${id.slice(0, -2)}00`;\n',
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::forges an id that differs from the original for every id, including one that already ends in the substitute",
  ],
};

export default aForgedIdIsAlwaysADifferentId;
