/** The recheck's after-read start-token check asks the kernel again instead of reusing its pinned snapshot. */
const c = {
  id: "claimant-recheck-rereads-start-token",
  what: "the live recheck re-reads the start token after its registry read",
  file: "src/registry/canonical-self-claim.ts",
  find: "readStartToken: (pid) => inspector.readStartToken !== undefined",
  replace: "readStartToken: (pid) => pid === identity.pid ? observed : inspector.readStartToken !== undefined",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::the live recheck reads the start token again after its registry read rather than reusing its snapshot",
  ],
};
export default c;
