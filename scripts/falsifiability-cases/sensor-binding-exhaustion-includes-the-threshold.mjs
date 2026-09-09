const x = {
  id: "sensor-binding-exhaustion-includes-the-threshold",
  what: "A CTO window exactly at the configured exhaustion threshold still overrides an unknown window.",
  file: "src/capacity/capacity-monitor.ts",
  find: "      bucket.remainingPercent <= this.#options.exhaustedPercent,",
  replace: "      bucket.remainingPercent < this.#options.exhaustedPercent,",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 B1: observed exhaustion at 2 percent dominates an unknown applicable window",
  ],
};
export default x;
