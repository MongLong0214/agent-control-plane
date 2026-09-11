/**
 * The mutation keeps the counter and removes the only thing that reads it.
 *
 * That is exactly the state #811 measured: `role-not-held` is counted by nothing and reaches
 * nothing, so a reconnect loop that will never succeed is indistinguishable from one that is
 * about to. A row that deleted the counting instead would be mutating bookkeeping; this one
 * mutates the report, which is the guard.
 */
const aPersistentRoleNotHeldRunIsReported = {
  id: "a-persistent-role-not-held-run-is-reported",
  what: "a persistent role-not-held run is reported",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find:
    "    this.#deps.reportRoleNotHeld({\n" +
    "      identityPubkey: this.#pubkey,\n" +
    "      roleKey: this.#roleKey,\n" +
    "      consecutive: this.#roleNotHeldRun,\n" +
    "    });\n",
  replace: "",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::reports a role-not-held run that has stopped being explicable as a race",
  ],
};

export default aPersistentRoleNotHeldRunIsReported;
