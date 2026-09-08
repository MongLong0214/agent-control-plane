/**
 * `EPERM` means the process is there and this deployment may not signal it. `Daemon.reconcile`'s
 * own `isAlive` folds every `kill` failure into "not alive", which is the right shape for a sweep
 * whose worst case is a lifecycle it can correct later; it is the wrong shape for a door that
 * releases an authority. Folding the two here would let a live CTO owned by another uid be
 * released as an absent one.
 */
const aLivenessProbeDoesNotReadASignalFailureAsDeath = {
  id: "a-liveness-probe-does-not-read-a-signal-failure-as-death",
  what: "a kill(2) failure that is not ESRCH never means the process is gone",
  file: "src/daemon/dead-binding-recovery.ts",
  find: '    if (code === "ESRCH") return "DEAD";\n',
  replace: '    return "DEAD";\n',
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::reads each outcome from the evidence, and refuses to guess",
  ],
};

export default aLivenessProbeDoesNotReadASignalFailureAsDeath;
