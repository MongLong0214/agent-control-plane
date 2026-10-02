/**
 * The rule is for a missing reading only. A reading that measured the incumbent's quota exhausted
 * is evidence against it, and the coverage hold's window decides then. Without the null test a
 * live incumbent would keep its binding through measured exhaustion for ever.
 */
const anUnreadCapacityRuleIsOnlyForAMissingReading = {
  id: "an-unread-capacity-rule-is-only-for-a-missing-reading",
  what: "a measured exhaustion still revokes a live incumbent once the coverage hold's window ends",
  file: "src/daemon/daemon.ts",
  find: "    if (capacity !== null) return false;\n    if (session?.lifecycle !== SessionLifecycle.READY) return false;\n",
  replace: "    if (session?.lifecycle !== SessionLifecycle.READY) return false;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::revokes for want of coverage once the gap outlasts the window",
  ],
};

export default anUnreadCapacityRuleIsOnlyForAMissingReading;
