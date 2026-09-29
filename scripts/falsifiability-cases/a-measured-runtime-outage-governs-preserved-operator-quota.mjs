// #1018: keeping the operator's quota must not keep its older runtime verdict.
const c = {
  id: "a-measured-runtime-outage-governs-preserved-operator-quota",
  what: "a collector ERROR preserves operator quota but persists its separately measured runtime health",
  file: "src/capacity/capacity-monitor.ts",
  find: "            runtimeHealth: reading.runtimeHealth,\n            observedAt: current.observedAt,\n",
  replace: "            runtimeHealth: current.runtimeHealth,\n            observedAt: current.observedAt,\n",
  killedBy: [
    "tests/unit/continuity-hardening.test.ts::a measured runtime outage governs a preserved operator quota after refresh",
  ],
};
export default c;
