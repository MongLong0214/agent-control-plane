/**
 * #954. Work is paused together with the revocation, when the window has passed, so a gap that
 * coverage closes inside the window leaves no paused run behind for a person to resume. The mutant
 * pauses on the first tick of the hold, as the revocation path used to.
 */
const aCoverageHoldPausesWorkOnlyWithTheRevocation = {
  id: "a-coverage-hold-pauses-work-only-with-the-revocation",
  what: "a coverage hold leaves active work running and pauses it only when the binding is revoked",
  file: "src/daemon/daemon.ts",
  find: "          if (this.holdsThroughCoverageGap(required.roleKey, current.bindingGeneration, session, currentCapacity)) continue;\n",
  replace: "          pausedRuns.push(...this.pauseAffectedRuns(required, CONTINUITY_COVERAGE_REVOCATION_REASON));\n          if (this.holdsThroughCoverageGap(required.roleKey, current.bindingGeneration, session, currentCapacity)) continue;\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::leaves active work running through the hold and pauses it with the revocation",
  ],
};

export default aCoverageHoldPausesWorkOnlyWithTheRevocation;
