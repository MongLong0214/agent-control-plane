// #1018: a failed quota sensor is not evidence that its runtime is unavailable.
const c = {
  id: "a-healthy-runtime-error-keeps-a-live-binding",
  what: "daemon reconciliation uses the measured healthy runtime with the preserved operator quota",
  file: "src/capacity/capacity-monitor.ts",
  find: "          sensorHealth: observed[0]!.sensor_health,\n          runtimeHealth: first.runtime_health,",
  replace: "          sensorHealth: observed[0]!.sensor_health,\n          runtimeHealth: \"UNAVAILABLE\",",
  killedBy: [
    "tests/unit/continuity-hardening.test.ts::daemon reconciliation keeps a live binding through ERROR plus measured HEALTHY",
  ],
};
export default c;
