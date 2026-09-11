/**
 * A row's lifecycle is a record this daemon wrote; a process's liveness is a fact the kernel holds.
 *
 * Nothing transitions a session row when its runtime dies, so a READY row routinely outlives the
 * process it names. Same-live recovery is a rule about a *live* actor replacing its own revoked
 * attachment; entering it on the row instead of on the process is what left the canonical CTO
 * unclaimable on production through the ordinary case, a restart (#831). The mutation below is
 * exactly that reading: a recorded pid that resolves to no process at all is read as "not gone",
 * the strict branch engages for an actor that does not exist, and the restarted claimant — a
 * different process by construction — is refused CONFLICT for failing to be the runtime it
 * replaced.
 */
const aPredecessorRowIsNotAPredecessorProcess = {
  id: "a-predecessor-row-is-not-a-predecessor-process",
  what: "a predecessor pid that resolves to no process is gone, so the restarted claim is not the same-live branch's case",
  file: "src/registry/canonical-self-claim.ts",
  find: "    if (observed === null) return true;\n",
  replace: "    if (observed === null) return false;\n",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a restarted canonical runtime claims the next generation when the predecessor row is READY and its process is gone",
  ],
};

export default aPredecessorRowIsNotAPredecessorProcess;
