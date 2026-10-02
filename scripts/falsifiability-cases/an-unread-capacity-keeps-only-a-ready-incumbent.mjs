/**
 * A running process is not enough: a session that is no longer READY loses its binding whatever
 * the capacity reading says, as #811 already required of a failed sensor. Dropping the lifecycle
 * test would keep a STOPPED session's binding for as long as its pid happened to stay alive.
 */
const anUnreadCapacityKeepsOnlyAReadyIncumbent = {
  id: "an-unread-capacity-keeps-only-a-ready-incumbent",
  what: "an incumbent whose session is no longer READY is revoked although its provider has no reading",
  file: "src/daemon/daemon.ts",
  find: "    if (session?.lifecycle !== SessionLifecycle.READY) return false;\n    if (session.osPid == null) return false;\n",
  replace: "    if (session === null) return false;\n    if (session.osPid == null) return false;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::still revokes an incumbent whose session is no longer READY, though its process runs",
  ],
};

export default anUnreadCapacityKeepsOnlyAReadyIncumbent;
