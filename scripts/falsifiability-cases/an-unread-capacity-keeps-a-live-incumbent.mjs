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
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::keeps a live incumbent whose provider has no reading, past the hold window",
    "tests/unit/daemon-sensor-failure-binding.test.ts::does not fail a live incumbent over to a routable provider because its own reading is missing",
  ],
};

export default anUnreadCapacityKeepsALiveIncumbent;
