/** verifyClaudeIdentity's post-image recheck re-derives through the reader its own derivation used. */
const c = {
  id: "verifier-recheck-uses-verifier-registry-reader",
  what: "the shared verifier's post-image recheck reads the registry through the verifier's reader",
  file: "src/registry/canonical-self-claim.ts",
  find: "assertClaudeIdentityStillLive(identity, processInspector, registryReader)",
  replace: "assertClaudeIdentityStillLive(identity, processInspector)",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::the delegated CTO verifier's post-image recheck refuses a registry that switched sessions",
  ],
};
export default c;
