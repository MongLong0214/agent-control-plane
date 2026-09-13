/**
 * #878. `git()`'s docblock names `worktree add --detach` as the slowest plausible call and offers
 * `timeoutMs` as the affordance that makes a blanket 120s bound safe. For one release the three
 * worktree mutators took no timeout and passed none, so that call was the one call no caller could
 * give more time.
 *
 * The mutation keeps the parameter and the spread and empties what it spreads, so the signature
 * still compiles and every caller still type-checks -- the shipped defect was exactly "the option
 * exists and does not arrive", not "the option is absent". Deleting the parameter instead would
 * fail at the call sites and die of `tsc` rather than of the witness.
 */
const theWorktreeMutatorsCanRaiseTheirBound = {
  id: "the-worktree-mutators-can-raise-their-bound",
  what: "a timeoutMs handed to addWorktree reaches the git invocation, so the bound the docblock offers can actually be raised",
  file: "src/git/git.ts",
  find: '    () => git(cwd, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, ref], {\n      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),',
  replace: '    () => git(cwd, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, ref], {\n      ...(options.timeoutMs === undefined ? {} : {}),',
  killedBy: [
    "tests/unit/guard-hardening.test.ts::refuses under a bound it cannot meet and succeeds under one it can",
  ],
};

export default theWorktreeMutatorsCanRaiseTheirBound;
