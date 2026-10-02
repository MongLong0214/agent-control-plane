/** The claim's checkpoints re-derive through the claim's own registry reader, not a default one. */
const c = {
  id: "claimant-recheck-uses-claim-registry-reader",
  what: "the claim's live rechecks read the registry through the claim's injected reader",
  file: "src/registry/canonical-self-claim.ts",
  find: "assertClaudeIdentityStillLive(identity, this.#processInspector, this.#hostSessionRegistryReader)",
  replace: "assertClaudeIdentityStillLive(identity, this.#processInspector)",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a registry that names CANON at every checkpoint is admitted from the registry as the control",
  ],
};
export default c;
