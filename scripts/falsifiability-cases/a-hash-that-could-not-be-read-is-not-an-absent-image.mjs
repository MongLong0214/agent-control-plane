/**
 * #1008 round 2 - an image the scan resolved but could not read comes back without a hash, never
 * as no image.
 *
 * `null` from an inspector means the scan ran and found no usable image. A read that failed after
 * the scan resolved the image is not that, and folding it into `null` is what the delegated CTO
 * binding would then attest: an observed image recorded as none. Returning the evidence without
 * `sha256` keeps the difference, and `a-delegated-bind-refuses-an-image-it-could-not-hash` is what
 * the delegated binding does with it.
 *
 * The mutant is the old fold. The killing test takes the read bit off a running image and requires
 * the hashing inspector to answer with its path and version, and no hash.
 */
const c = {
  id: "a-hash-that-could-not-be-read-is-not-an-absent-image",
  what: "an image the scan resolved but whose bytes could not be read is reported without a hash, never as no image",
  file: "src/registry/canonical-self-claim.ts",
  find: "  if (imageSha256 === null) return observed.evidence;",
  replace: "  if (imageSha256 === null) return null;",
  killedBy: [
    "tests/process/canonical-self-claim-identity.test.ts::the hashing inspector reports an image it could not read without a hash",
  ],
};
export default c;
