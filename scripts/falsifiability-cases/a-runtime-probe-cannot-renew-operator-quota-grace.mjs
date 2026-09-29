// #1018 A1018-1: quota age belongs to the original operator observation.
const c = {
  id: "a-runtime-probe-cannot-renew-operator-quota-grace",
  what: "a measured runtime verdict does not move the operator quota observedAt",
  file: "src/capacity/capacity-monitor.ts",
  find: "          observedAt: observed[0]!.observed_at,\n          source: provenance.source,",
  replace: "          observedAt: first.observed_at,\n          source: provenance.source,",
  killedBy: [
    "tests/unit/continuity-hardening.test.ts::a runtime-only measurement retains its own provenance without renewing operator quota grace",
  ],
};
export default c;
