/**
 * #954. A role the coverage plan cannot staff used to lose its binding on the first tick, and only a
 * claim brings a revoked binding back, so a gap of minutes became a human action. The mutant removes
 * the hold and revokes at once; the killing test sees the binding gone on the first tick of a gap
 * that coverage closes 149 seconds later.
 */
const aLiveIncumbentIsHeldThroughACoverageGap = {
  id: "a-live-incumbent-is-held-through-a-coverage-gap",
  what: "a live incumbent of a role the coverage plan cannot staff keeps its binding through the grace window",
  file: "src/daemon/daemon.ts",
  find: "          if (this.holdsThroughCoverageGap(required.roleKey, current.bindingGeneration, session, currentCapacity)) continue;\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::keeps the same generation when coverage returns inside the window, with no claim",
  ],
};

export default aLiveIncumbentIsHeldThroughACoverageGap;
