/**
 * #1008 round 2 - an image whose bytes this uid cannot read still yields its path and version on
 * the canonical path.
 *
 * Before this, the canonical inspector opened the image to hash it, and an open or a read that
 * failed returned `null`: the claim recorded no image for a process whose path and version were
 * perfectly observable. The label check is now a `stat` of the reported path against lsof's
 * (device, inode) — metadata only, no read permission needed.
 *
 * The mutant puts the open back into that check, the shape the code had. The killing test runs a
 * real process, takes the read bit off its image while it runs (the kernel has already mapped it),
 * and requires the canonical inspector to report the same path and version it reported while the
 * image was readable; with the open in place the open fails with EACCES and the observation is
 * `null`. The mutant also leaks the FD it opens, which is irrelevant to a test process.
 *
 * Which row witnesses which fact: this one, that an unreadable image is still observed. It does
 * not witness that the canonical inspector reads no bytes: an inspector that tries the read, fails
 * on the unreadable image and drops only the hash gives this test the same answer (measured
 * against `the-canonical-image-observation-reads-no-bytes`'s mutant, which passes here). That
 * row's test counts the opens and reads at `node:fs`, and it is the one that witnesses the read.
 */
const c = {
  id: "an-image-the-uid-cannot-read-is-still-observed",
  what: "the canonical claim checks the image's path against lsof's inode with a stat, not an open, so an image this uid cannot read still yields its path and version",
  file: "src/registry/canonical-self-claim.ts",
  find: "isReportedImageFile(statSync(imagePath, { bigint: true }), reported)",
  replace: 'isReportedImageFile(fstatSync(openSync(imagePath, "r"), { bigint: true }), reported)',
  killedBy: [
    "tests/process/canonical-self-claim-identity.test.ts::an image this uid cannot read is still observed by path and version on the canonical path",
  ],
};
export default c;
