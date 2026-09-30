/**
 * #1008 round 2 - the canonical claim's inspector does not read the executing image.
 *
 * The canonical attestation and receipt take the image's path and version and nothing else. The
 * inspector used to hash the whole binary on every claim anyway, for a `sha256` nothing on that
 * path reads, and a failed read of it discarded the path and version with it. The hash now has one
 * producer, `hashingExecutingImageInspector`, for its one reader, the delegated CTO binding.
 *
 * Round 3: this row's claim is about a read, so the read is measured where it happens rather than
 * inferred from the returned shape. The earlier mutant made the canonical inspector the hashing
 * one, and it died only because it *returned* a `sha256`; an inspector that read and hashed every
 * byte and dropped the hash returned exactly the path and version and passed. That mutant is this
 * row's now. The killing test counts, at `node:fs` (spied on for its whole file), every open of
 * the image's inode and every read of a descriptor such an open returned while the canonical
 * inspector runs, and requires none; the same count taken through the hashing inspector has to
 * see the open and the read, so an empty count cannot mean the spy missed the module. The mutant
 * that returns the hash still dies in that test, on the shape assertion ahead of the count.
 *
 * What the count cannot see: a read by another process, or by an asynchronous `node:fs` call.
 *
 * Which row witnesses which fact: this one, the read. `an-image-the-uid-cannot-read-is-still-observed`
 * witnesses that an unreadable image keeps its path and version. It does not witness the read —
 * this row's mutant tries the read, fails on the unreadable image, drops only the hash, and passes
 * that row's test (measured).
 */
const c = {
  id: "the-canonical-image-observation-reads-no-bytes",
  what: "the canonical claim's inspector resolves the image's path and version without opening or reading the image, counted at node:fs rather than inferred from the returned shape",
  file: "src/registry/canonical-self-claim.ts",
  find: "  resolve: (pid) => resolveExecutingImage(pid, false),",
  replace: '  resolve: (pid) => { const read = resolveExecutingImage(pid, true); if (read === null || "probeFailure" in read) return read; return { imagePath: read.imagePath, version: read.version }; },',
  killedBy: [
    "tests/process/canonical-self-claim-identity.test.ts::the canonical inspector opens and reads no byte of the image it observes by path and version",
  ],
};
export default c;
