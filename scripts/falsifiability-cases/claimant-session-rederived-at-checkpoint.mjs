/** A checkpoint refuses when the re-derived session differs from the one verified earlier in the claim. */
const c = {
  id: "claimant-session-rederived-at-checkpoint",
  what: "the live recheck refuses a session that changed under the same pid and start token",
  file: "src/registry/canonical-self-claim.ts",
  find: "rederived.value.sessionUuid !== identity.sessionUuid",
  replace: "rederived.value.sessionUuid !== rederived.value.sessionUuid",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a registry that switches after the post-Buzz recheck is refused at the commit checkpoint, and nothing is written",
  ],
};
export default c;
