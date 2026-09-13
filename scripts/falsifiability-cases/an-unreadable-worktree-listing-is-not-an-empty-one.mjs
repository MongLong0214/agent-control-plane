/**
 * #869, GIT-1's third site. `listWorktrees` answered `[]` for a nonzero exit, and four of its five
 * callers read absence as a fact about the filesystem -- `destroy()` worst of all, where the
 * `remaining` check certifies that `ISOLATION_LOST` did not happen while having observed nothing.
 *
 * The mutation restores that exact behaviour by making the guard unreachable rather than by
 * deleting it, so the function falls through and parses the empty stdout of the failed call into
 * an empty array -- the shipped defect, not an approximation of it. `< -1` is chosen because a
 * process exit code cannot be negative, and because it adds no `&&`/`||` operand that the refusal
 * census would then have to answer for.
 */
const anUnreadableWorktreeListingIsNotAnEmptyOne = {
  id: "an-unreadable-worktree-listing-is-not-an-empty-one",
  what: "a worktree listing git refused is a refusal, never an empty list of worktrees",
  file: "src/git/git.ts",
  find: "  if (out.exitCode !== 0) {",
  replace: "  if (out.exitCode < -1) {",
  killedBy: [
    "tests/unit/an-unreadable-worktree-listing-is-not-an-empty-one.test.ts::refuses instead of reporting that the repository has no worktrees",
  ],
};

export default anUnreadableWorktreeListingIsNotAnEmptyOne;
