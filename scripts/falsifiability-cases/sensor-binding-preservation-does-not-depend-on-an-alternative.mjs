const x = {
  id: "sensor-binding-preservation-does-not-depend-on-an-alternative",
  what: "Unread Claude quota preserves the READY incumbent even when the plan can staff CTO with GPT.",
  file: "src/daemon/daemon.ts",
  find: "        if (\n          session?.lifecycle === SessionLifecycle.READY &&\n",
  replace: "        if (\n          !assignment?.provider &&\n          session?.lifecycle === SessionLifecycle.READY &&\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::(#811: a READY CTO binding survives a failed capacity sensor|#812 R2: an unknown applicable bucket preserves the READY incumbent)",
  ],
};
export default x;
