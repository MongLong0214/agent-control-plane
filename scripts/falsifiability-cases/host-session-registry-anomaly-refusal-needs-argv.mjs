/** Without a selector the no-session-id refusal names the registry's own failure, not the argv refusal. */
const c = {
  id: "host-session-registry-anomaly-refusal-needs-argv",
  what: "the argv-selector refusal for a registry anomaly applies only when argv named a selector",
  file: "src/registry/canonical-self-claim.ts",
  find: "argvSessionUuid && !isHostSessionRegistryAbsent(registry)",
  replace: "true && !isHostSessionRegistryAbsent(registry)",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::names the missing selector, not the argv refusal, for an unverifiable registry without a selector",
  ],
};
export default c;
