/**
 * #833 - the file the inspector hashes is the file the kernel says the process is running.
 *
 * `lsof` reports a path and a (device, inode) pair; the path is then opened and `fstat`ed, and this
 * operand is what binds the opened handle to the reported identity. Removing it leaves the device
 * check, which a decoy swapped in at the same path on the same volume satisfies - so the inspector
 * would hash the decoy and hand back evidence carrying the decoy's bytes as the claimant's image.
 *
 * What that evidence reaches changed on 2026-09-27, when the claim stopped comparing the image
 * against a pinned version, realpath and digest. Nothing is refused on the image any more, so this
 * guard no longer keeps a decoy from being admitted; it keeps the observation true. The decoy shares
 * the path and therefore the version the canonical receipt records, so there the mutant's only
 * visible effect is an image recorded where none was resolved. Its bytes reach one reader: the
 * delegated CTO binding's attestation digest, which digests the whole verified identity, sha256
 * included (`cto-binding-runtime.ts`).
 *
 * Its sibling `stat.dev !== reportedDevice` survived and carries a reason: distinguishing it needs
 * a decoy on a different device, which this suite has no way to build on one volume.
 *
 * The killing test was retitled with this prose, from "refuses rather than hashes" to "resolves no
 * image rather than hashing", because the inspector never refused a claim and the claim no longer
 * refuses on the image. The retitle moved the anchor and changed nothing the test asserts: on
 * Darwin it still requires the inspector to resolve no image after the swap. Exercised with `--only`
 * before the retitle: `killed`.
 */
const c = {
  id: "the-opened-image-is-the-reported-inode",
  what:
    "the image the inspector hashes is the inode lsof reported, so a decoy swapped in at the same "
    + "path resolves to no image rather than being hashed and recorded as the claimant's",
  file: "src/registry/canonical-self-claim.ts",
  find: " || stat.ino !== reportedInode",
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-identity.test.ts::resolves no image rather than hashing a decoy when the resolved image path is replaced after the running process opened it",
  ],
};
export default c;
