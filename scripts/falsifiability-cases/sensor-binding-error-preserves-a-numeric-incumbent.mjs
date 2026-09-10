const x = {
  id: "sensor-binding-error-preserves-a-numeric-incumbent",
  what: "A sensor error preserves a READY incumbent even when its quota buckets are numeric.",
  file: "src/daemon/daemon.ts",
  find: "          (currentCapacity.sensorHealth === \"ERROR\" ||\n",
  replace: "          (false ||\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#811: an ERROR sensor with numeric buckets still preserves the READY incumbent",
  ],
};
export default x;
