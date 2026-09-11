/**
 * The daemon lock is what makes exactly one process the authority behind the claim socket. A
 * daemon that has lost it and keeps answering means two processes answer the same claim, and the
 * socket stops naming one authority.
 *
 * The guard existed and nothing drove it: every fixture in both listener test files supplied
 * `held: () => true`, so deleting this block left the suite green (#843). It is a unary `!`, so
 * the refusal-operand census does not select it either (#839) — neither mechanism was going to
 * ask for a witness, which is why this row is written by hand.
 */
const anUnheldDaemonLockStopsAnsweringClaims = {
  id: "an-unheld-daemon-lock-stops-answering-claims",
  what: "a daemon that does not hold its lock refuses the claim instead of dispatching it",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: "      if (!daemon.lock.held()) {\n",
  replace: "      if (false) {\n",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses a well-formed claim with DAEMON_LOCK_LOST and never reaches the handler",
  ],
};

export default anUnheldDaemonLockStopsAnsweringClaims;
