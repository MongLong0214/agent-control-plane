const x = {
  id: "sensor-binding-preservation-requires-an-available-runtime",
  what: "An unavailable runtime still loses its READY binding when the capacity sensor fails.",
  file: "src/daemon/daemon.ts",
  find: "          currentCapacity.runtimeHealth !== \"UNAVAILABLE\" &&\n",
  replace: "          true &&\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#811: an UNAVAILABLE runtime still revokes a READY binding during a sensor failure",
  ],
};
export default x;
