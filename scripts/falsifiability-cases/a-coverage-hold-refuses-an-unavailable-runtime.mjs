/**
 * #954. An UNAVAILABLE runtime is evidence against the incumbent, not a gap in quota, so it is
 * revoked at once as before the hold existed. The mutant lets such an incumbent be held.
 */
const aCoverageHoldRefusesAnUnavailableRuntime = {
  id: "a-coverage-hold-refuses-an-unavailable-runtime",
  what: "a coverage hold does not keep an incumbent whose runtime its own reading calls UNAVAILABLE",
  file: "src/daemon/daemon.ts",
  find: "    if (capacity?.runtimeHealth === \"UNAVAILABLE\") return false;\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#954: a healthy sensor with unknown CTO quota and unavailable runtime revokes a live native incumbent",
  ],
};

export default aCoverageHoldRefusesAnUnavailableRuntime;
