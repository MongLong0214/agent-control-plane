/**
 * #869. `-q` makes exit 1 git's answer "HEAD is not a symbolic ref", which is what detached means
 * here. Every other nonzero is a fatal -- git uses 128 for all of them -- and reading those as
 * detached let this assertion pass having observed nothing, certifying the property it was asked
 * to check.
 *
 * The mutation makes the guard unreachable rather than deleting it, so control flows exactly as it
 * did before the repair: a fatal falls past both branches and the binding is asserted. `< -1` is
 * chosen because a process exit code cannot be negative and it introduces no `&&`/`||` operand for
 * the refusal census to answer for.
 *
 * The row exists because a merge-gate review measured that nothing in the suite reached this
 * region at all: inverting the guard left 500 tests green. An unwitnessed guard and a removed one
 * are the same guard.
 */
const aHeadThatCouldNotBeReadIsNotADetachedHead = {
  id: "a-head-that-could-not-be-read-is-not-a-detached-head",
  what: "a symbolic-ref probe that ended in a fatal is refused, never recorded as a detached HEAD",
  file: "src/snapshot/candidate-snapshot.ts",
  find: "  if (symbolicHead.exitCode !== 1) {",
  replace: "  if (symbolicHead.exitCode < -1) {",
  killedBy: [
    "tests/unit/a-head-that-could-not-be-read-is-not-a-detached-head.test.ts::refuses a HEAD it could not read, rather than calling the fatal a detached head",
  ],
};

export default aHeadThatCouldNotBeReadIsNotADetachedHead;
