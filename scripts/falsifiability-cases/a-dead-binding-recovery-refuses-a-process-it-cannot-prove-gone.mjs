/**
 * "Unknown" is a refusal, not a permission.
 *
 * Widening the release condition from "proven dead" to "not proven alive" is the single edit that
 * turns this door from a recovery into an eviction: a session whose pid was never recorded, or
 * whose liveness cannot be read, would have its authority released on the strength of the fact
 * that nothing could be established about it. A live incumbent whose probe merely failed is the
 * case that costs.
 */
const aDeadBindingRecoveryRefusesAProcessItCannotProveGone = {
  id: "a-dead-binding-recovery-refuses-a-process-it-cannot-prove-gone",
  what: "only a session proven dead is released; unproven liveness refuses",
  file: "src/daemon/dead-binding-recovery.ts",
  find: '    if (liveness !== "DEAD") {\n',
  replace: '    if (liveness === "ALIVE") {\n',
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::refuses a session whose liveness cannot be determined",
  ],
};

export default aDeadBindingRecoveryRefusesAProcessItCannotProveGone;
