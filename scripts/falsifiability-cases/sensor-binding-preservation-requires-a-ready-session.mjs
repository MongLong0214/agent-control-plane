const x = {
  id: "sensor-binding-preservation-requires-a-ready-session",
  what: "A stopped incumbent still loses its binding when the capacity sensor fails.",
  file: "src/daemon/daemon.ts",
  find: "        if (\n          session?.lifecycle === SessionLifecycle.READY &&\n",
  replace: "        if (\n          true &&\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#811: a non-READY session still loses its binding during a sensor failure",
  ],
};
export default x;
