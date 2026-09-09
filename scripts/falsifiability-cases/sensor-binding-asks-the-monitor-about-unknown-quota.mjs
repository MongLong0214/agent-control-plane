// #812 R2: the earlier hand mutation r2-delete-monitor-question, rerun through the harness.
const x = {
  id: "sensor-binding-asks-the-monitor-about-unknown-quota",
  what: "An unknown CTO window preserves its READY incumbent despite numeric worker quota.",
  file: "src/daemon/daemon.ts",
  find: "            this.cp.capacity.hasUnknownQuotaFor(currentCapacity, required.capability))\n",
  replace: "            false)\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 R2: an unknown applicable bucket preserves the READY incumbent \\(numeric worker bucket\\)",
  ],
};
export default x;
