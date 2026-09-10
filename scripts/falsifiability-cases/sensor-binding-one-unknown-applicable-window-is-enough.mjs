// #812 R2: the earlier hand mutation r2-any-to-all, rerun through the harness.
const x = {
  id: "sensor-binding-one-unknown-applicable-window-is-enough",
  what: "One unknown CTO window preserves the READY incumbent when another CTO window has usable numeric quota.",
  file: "src/capacity/capacity-monitor.ts",
  find: "    return applicable.length === 0 || applicable.some((bucket) => !Number.isFinite(bucket.remainingPercent));",
  replace: "    return applicable.length === 0 || applicable.every((bucket) => !Number.isFinite(bucket.remainingPercent));",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 R2: an unknown applicable bucket preserves the READY incumbent \\(numeric cto bucket\\)",
  ],
};
export default x;
