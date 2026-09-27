/**
 * #1008 round 2 - the canonical claim's inspector does not read the executing image.
 *
 * The canonical attestation and receipt take the image's path and version and nothing else. The
 * inspector used to hash the whole binary on every claim anyway, for a `sha256` nothing on that
 * path reads, and a failed read of it discarded the path and version with it. The hash now has one
 * producer, `hashingExecutingImageInspector`, for its one reader, the delegated CTO binding.
 *
 * The mutant makes the canonical inspector the hashing one. On a readable image it then returns a
 * `sha256` key, and the killing test requires the canonical observation to be exactly the path and
 * version. It does not fail on the unreadable image: the hashing resolver reports that one without
 * a hash rather than as no image, so the regression this row catches is the cost, and
 * `an-image-the-uid-cannot-read-is-still-observed` is the one that catches the lost observation.
 */
const c = {
  id: "the-canonical-image-observation-reads-no-bytes",
  what: "the canonical claim's inspector resolves the image's path and version without reading the image's bytes",
  file: "src/registry/canonical-self-claim.ts",
  find: "  resolve: (pid) => resolveExecutingImage(pid, false),",
  replace: "  resolve: (pid) => resolveExecutingImage(pid, true),",
  killedBy: [
    "tests/process/canonical-self-claim-identity.test.ts::the canonical inspector observes an image by path and version without reading it",
  ],
};
export default c;
