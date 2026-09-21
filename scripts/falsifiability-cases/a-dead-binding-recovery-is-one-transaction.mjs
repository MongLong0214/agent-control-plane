/**
 * The re-read of the binding, the revoke — which fences the outbox inside the same transaction,
 * in `BindingRegistry.revoke` — and the audit record are one commit or none. Replacing the
 * transaction with a plain call leaves each of those writes to stand on its own, so a failure at
 * the revoke leaves the outbox fenced against a generation that still holds the role, with no
 * audit record naming what happened to it.
 *
 * This used to cover the owner approval's admission and consumption too. Those are gone; the
 * writes that remain are the ones that were always the reason a rollback had to be whole.
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
