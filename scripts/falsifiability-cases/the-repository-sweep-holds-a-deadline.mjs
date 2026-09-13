/**
 * #877. `checkRepositories` probes each registered repository with two git calls, and each
 * inherited `git()`'s blanket 120s -- so N repositories could cost N x 120s inside a `doctor.run`
 * budget of 165s. One slow checkout after slow collectors expired the method, and the expiry
 * discarded the partial report #869's per-repository catch had just been added to preserve: the
 * guard worked and the operator never saw its finding.
 *
 * The mutation makes the deadline check unreachable, which is exactly the shipped behaviour --
 * every repository probed with whatever time is left and none reported as unreached. `< -1` is
 * used because a millisecond remainder cannot be negative past that, the mutant compiles, and no
 * `&&`/`||` operand is added for the refusal census to answer for.
 */
const theRepositorySweepHoldsADeadline = {
  id: "the-repository-sweep-holds-a-deadline",
  what: "the repository sweep stops at its own deadline and reports the checkouts it did not reach, rather than spending the doctor's whole budget",
  file: "src/doctor/doctor.ts",
  find: "      if (remainingMs <= 0) {",
  replace: "      if (remainingMs < -1) {",
  killedBy: [
    "tests/unit/one-unreadable-checkout-does-not-discard-the-doctor-report.test.ts::reports the checkouts the sweep did not reach instead of omitting them",
  ],
};

export default theRepositorySweepHoldsADeadline;
