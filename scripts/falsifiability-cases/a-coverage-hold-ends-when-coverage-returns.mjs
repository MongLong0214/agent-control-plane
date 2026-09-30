/**
 * #954. A hold ends when the incumbent's provider covers the role again, and the ledger says the
 * revocation was withdrawn. The mutant leaves the hold in place, so nothing records that the gap
 * closed without a human and the next gap inherits this one's start.
 */
const aCoverageHoldEndsWhenCoverageReturns = {
  id: "a-coverage-hold-ends-when-coverage-returns",
  what: "a held role whose incumbent is covered again leaves a withdrawal record and starts any later gap afresh",
  file: "src/daemon/daemon.ts",
  find: "          this.releaseCoverageHold(required.roleKey, current.bindingGeneration, \"the incumbent's provider covers the role again\");\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::keeps the same generation when coverage returns inside the window, with no claim",
  ],
};

export default aCoverageHoldEndsWhenCoverageReturns;
