/**
 * #833 - the image the inspector reports is the file the kernel says the process is running.
 *
 * `lsof` reports a path and a (device, inode) pair, and this operand is what binds what the path
 * names to the reported identity. Removing it leaves the device check, which a decoy swapped in at
 * the same path on the same volume satisfies.
 *
 * What that evidence reaches changed on 2026-09-27, when the claim stopped comparing the image
 * against a pinned version, realpath and digest. Nothing is refused on the image any more, so this
 * guard no longer keeps a decoy from being admitted; it keeps the observation true.
 *
 * The anchor moved in #1008 round 2, when the canonical inspector stopped reading the image. The
 * comparison left `openVerifiedDarwinImageFd` for `isReportedImageFile`, which two sites now call:
 * `pathIsReportedImageFile`, a `stat` of the reported path that every inspector runs before it
 * returns an image, and `openVerifiedDarwinImageFd`, the `fstat` of the FD whose bytes the hashing
 * inspector reads. Re-derived at the new site rather than carried: with the operand removed, a
 * decoy renamed over the image passes the `stat` on its device alone, so the canonical inspector
 * records the decoy's path and version as the claimant's image — the path, and therefore the
 * version, the canonical receipt records — and the hashing inspector goes on to hash the decoy's
 * bytes for the delegated binding's attestation digest. The killing test asserts, on Darwin, that
 * both inspectors resolve no image after the swap; the canonical assertion runs first, and it is
 * the one that fails.
 *
 * What the kill does not reach: the `fstat` call site on its own. A swap that lands after the
 * `stat` and before the open is the only input that separates the two sites, and this suite cannot
 * time one. The operand is shared, so the kill witnesses it; it does not witness that the `fstat`
 * call still passes it.
 *
 * Its sibling `stat.dev === reported.device` survived and carries a reason: distinguishing it needs
 * a decoy on a different device, which this suite has no way to build on one volume.
 */
const c = {
  id: "the-opened-image-is-the-reported-inode",
  what:
    "the image the inspector reports is the inode lsof reported, so a decoy swapped in at the same "
    + "path resolves to no image rather than being recorded or hashed as the claimant's",
  file: "src/registry/canonical-self-claim.ts",
  find: " && stat.ino === reported.inode",
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-identity.test.ts::resolves no image rather than hashing a decoy when the resolved image path is replaced after the running process opened it",
  ],
};
export default c;
