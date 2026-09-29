// #1018 A1018-1: a completed run's historical capacity rows are export evidence.
const c = {
  id: "a-later-runtime-measurement-cannot-rewrite-run-evidence",
  what: "a measured collector error is persisted at its own time rather than the operator observation's time",
  file: "src/capacity/capacity-monitor.ts",
  find: "    if (reading.runtimeHealth !== \"UNKNOWN\" && reading.observedAt > current.observedAt) {\n      this.record({ ...reading, buckets: [] });\n    }",
  replace: "    if (reading.runtimeHealth !== \"UNKNOWN\" && reading.observedAt > current.observedAt) {\n      this.record({ ...current, runtimeHealth: reading.runtimeHealth }, storedOperatorObservationSource(current.operatorObservation));\n    }",
  killedBy: [
    "tests/unit/baseline-export.test.ts::a later runtime measurement leaves a completed run export and its verification unchanged",
  ],
};
export default c;
