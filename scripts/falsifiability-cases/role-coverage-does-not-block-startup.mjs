/**
 * Coverage is availability. Making a measured NO_VALID_COVERAGE blocking again parks the daemon,
 * or ends it beside another blocker, before the claim socket and cto.mcp.sock open — a quota
 * reading as a precondition for connecting. Routing already refuses new work on the same plan.
 */
const roleCoverageDoesNotBlockStartup = {
  id: "role-coverage-does-not-block-startup",
  what: "a measured deployment with nothing routable is reported without blocking",
  file: "src/doctor/doctor.ts",
  find: "        scope: \"continuity\",\n        blocking: false,\n",
  replace: "        scope: \"continuity\",\n        blocking: !nothingMeasured && plan.outcome === \"NO_VALID_COVERAGE\",\n",
  killedBy: [
    "tests/unit/the-doctor-measures-the-role-before-it-scores-it.test.ts::reports a measured deployment with nothing routable as degraded, without blocking",
  ],
};

export default roleCoverageDoesNotBlockStartup;
