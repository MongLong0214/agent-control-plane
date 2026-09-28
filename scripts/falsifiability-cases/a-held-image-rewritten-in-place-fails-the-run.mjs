/**
 * A held image whose bytes changed in place fails the run.
 *
 * A hard link keeps out every rename and delete, but a write to the inode itself reaches the link
 * too. `confirmHeld` re-digests after each arm, and a digest that is no longer the held one is a
 * thrown run, not a reading. The killing row rewrites the inode and restores its size and
 * modification time, so the digest is the only thing left that can tell.
 */
const aHeldImageRewrittenInPlaceFailsTheRun = {
  id: "a-held-image-rewritten-in-place-fails-the-run",
  what: "a qualification run fails when the held image's bytes change after they were digested",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "  if (sha256 !== image.sha256) {\n",
  replace: "  if (sha256 !== sha256) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-image-hold.test.ts::a rewrite of the held inode in place fails the run, even one that keeps its size and modification time",
  ],
};

export default aHeldImageRewrittenInPlaceFailsTheRun;
