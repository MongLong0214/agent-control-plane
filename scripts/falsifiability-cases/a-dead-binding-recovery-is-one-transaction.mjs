/**
 * The admission of the owner approval, its consumption, the revoke and the audit are one commit
 * or none. Replacing the transaction with a plain call leaves each of those writes to stand on
 * its own, so a failure at the revoke leaves an owner decision on record — and a spent nonce —
 * for a release that did not happen.
 */
const aDeadBindingRecoveryIsOneTransaction = {
  id: "a-dead-binding-recovery-is-one-transaction",
  what: "a recovery that fails part-way through commits none of its writes",
  file: "src/daemon/dead-binding-recovery.ts",
  find: "  return deps.db.txDecision<DeadBindingRecoveryReceipt>(() => {\n",
  replace:
    "  return ((body: () => Decision<DeadBindingRecoveryReceipt>) => body())(() => {\n",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::leaves no partial change when the release fails mid-flight",
  ],
};

export default aDeadBindingRecoveryIsOneTransaction;
