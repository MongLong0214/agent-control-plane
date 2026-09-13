/**
 * #833 - the file the claim hashes is the file the kernel says the process is running.
 *
 * `lsof` reports a path and a (device, inode) pair; the path is then opened and `fstat`ed, and this
 * operand is what binds the opened handle to the reported identity. Removing it leaves the device
 * check, which a decoy swapped in at the same path on the same volume satisfies - so the claim
 * would hash the decoy and compare *that* against the pinned digest.
 *
 * Its sibling `stat.dev !== reportedDevice` survived and carries a reason: distinguishing it needs
 * a decoy on a different device, which this suite has no way to build on one volume.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "the-opened-image-is-the-reported-inode",
  what:
    "the image the claim hashes is the inode lsof reported, so a decoy swapped in at the same "
    + "path is refused rather than hashed",
  file: "src/registry/canonical-self-claim.ts",
  find: " || stat.ino !== reportedInode",
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-identity.test.ts::refuses rather than hashes a decoy when the resolved image path is replaced after the running process opened it",
  ],
};
export default c;
