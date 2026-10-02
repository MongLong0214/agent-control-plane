/**
 * A READY incumbent whose provider has no capacity reading at all keeps its binding while its
 * recorded process is still running. Removing the call puts the daemon back where #811 left the
 * null case: through the coverage hold to revocation, or straight to failover when another
 * provider could staff the role. The mutant passes a null session, so the method stays in use and
 * the mutant compiles; it can only answer false.
 */
const anUnreadCapacityKeepsALiveIncumbent = {
  id: "an-unread-capacity-keeps-a-live-incumbent",
  what: "a live incumbent is neither revoked nor failed over because its provider has no reading",
  file: "src/daemon/daemon.ts",
  find: "        if (this.keepsIncumbentThroughUnreadCapacity(session, currentCapacity)) {\n",
  replace: "        if (this.keepsIncumbentThroughUnreadCapacity(null, currentCapacity)) {\n",
  // One test only: the harness runs `vitest -t`, which takes a single name. The failover case in
  // the same file dies to this mutant too (measured by hand), and is not named here for that reason.
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::keeps a live incumbent whose provider has no reading, past the hold window",
  ],
};

export default anUnreadCapacityKeepsALiveIncumbent;
