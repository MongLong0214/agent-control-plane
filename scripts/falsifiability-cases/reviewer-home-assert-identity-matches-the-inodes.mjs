/**
 * `assertReviewerCodexHome` re-checks at every exec/resume, not only at claim. Weakening it lets a
 * home replaced after the claim keep serving a binding that was admitted against the old inode.
 */
const reviewerHomeAssertIdentityMatchesTheInodes = {
  id: "reviewer-home-assert-identity-matches-the-inodes",
  what: "a reviewer CODEX_HOME binding is re-refused at use when its device/inode pair stops naming the same home and capsule",
  file: "src/runtime/reviewer-codex-home.ts",
  find: `    if (binding.dev !== home.dev || binding.ino !== home.ino ||
        binding.capsuleDev !== capsule.dev || binding.capsuleIno !== capsule.ino) fail();`,
  replace: `    if (binding.dev !== home.dev) fail();`,
  killedBy: [
    "tests/unit/reviewer-codex-home.test.ts::rejects symlink or new-inode replacement before exec/resume",
  ],
};

export default reviewerHomeAssertIdentityMatchesTheInodes;
