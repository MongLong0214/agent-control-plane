// #812 R2: the earlier hand mutation r2-delete-empty, rerun through the harness.
const x = {
  id: "sensor-binding-empty-applicable-quota-is-unknown",
  what: "An empty applicable quota reading preserves the READY incumbent without a sensor error.",
  file: "src/capacity/capacity-monitor.ts",
  find: "    return applicable.length === 0 || applicable.some((bucket) => !Number.isFinite(bucket.remainingPercent));",
  replace: "    return applicable.some((bucket) => !Number.isFinite(bucket.remainingPercent));",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#811: a 'empty' reading without ERROR preserves the READY incumbent",
  ],
};
export default x;
