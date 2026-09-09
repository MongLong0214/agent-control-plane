// #812 R2: the earlier hand mutation r2-delete-applicability, rerun through the harness.
// UNANSWERED: restoring the inline filter in isRoutableFor computes exactly the same
// applicable buckets as applicableBucketsFor. Its callers cannot distinguish that
// equivalent implementation; it has no independent behavioral witness. This row
// deletes capability filtering itself, not the shared-helper call in isRoutableFor.
const x = {
  id: "sensor-binding-unknown-quota-must-apply-to-the-role",
  what: "An unrelated unknown worker window cannot hide exhausted CTO quota.",
  file: "src/capacity/capacity-monitor.ts",
  find: "    return capacity.buckets.filter((bucket) => bucket.capabilities.includes(capability));",
  replace: "    return capacity.buckets;",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 R2: an unrelated unknown bucket does not hide exhausted CTO quota",
  ],
};
export default x;
