// #812 B1: exhaustion now dominates unknown quota, so the old [cto: 0, worker: null]
// witness no longer distinguishes this mutation. Reverse the capabilities to witness it.
// UNANSWERED: restoring the inline filter in isRoutableFor computes exactly the same
// applicable buckets as applicableBucketsFor. Its callers cannot distinguish that
// equivalent implementation; it has no independent behavioral witness. This row
// deletes capability filtering itself, not the shared-helper call in isRoutableFor.
const x = {
  id: "sensor-binding-unknown-quota-must-apply-to-the-role",
  what: "An exhausted worker window is not evidence against an incumbent with unknown CTO quota.",
  file: "src/capacity/capacity-monitor.ts",
  find: "    return capacity.buckets.filter((bucket) => bucket.capabilities.includes(capability));",
  replace: "    return capacity.buckets;",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 B1: exhausted worker quota does not evict an incumbent with unknown CTO quota",
  ],
};
export default x;
