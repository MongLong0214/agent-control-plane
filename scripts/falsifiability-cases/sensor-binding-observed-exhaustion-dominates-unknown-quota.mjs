const x = {
  id: "sensor-binding-observed-exhaustion-dominates-unknown-quota",
  what: "Observed CTO exhaustion overrides an unknown CTO window when deciding whether to preserve the incumbent.",
  file: "src/daemon/daemon.ts",
  find: "          !this.cp.capacity.hasExhaustedQuotaFor(currentCapacity, required.capability) &&\n",
  replace: "          true &&\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 B1: observed exhaustion at 0 percent dominates an unknown applicable window",
  ],
};
export default x;
