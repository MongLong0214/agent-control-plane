const x = {
  id: "sensor-binding-one-exhausted-window-is-enough",
  what: "One observed exhausted CTO window suffices even when the other CTO window is unknown.",
  file: "src/capacity/capacity-monitor.ts",
  find: "    return this.applicableBucketsFor(capacity, capability).some((bucket) =>",
  replace: "    return this.applicableBucketsFor(capacity, capability).every((bucket) =>",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 B1: observed exhaustion at 0 percent dominates an unknown applicable window",
  ],
};
export default x;
