/** A registry read that found a file and could not verify it refuses even a valid argv selector. */
const c = {
  id: "host-session-registry-anomaly-refuses-argv",
  what: "a registry anomaly other than absence refuses a valid argv selector",
  file: "src/registry/canonical-self-claim.ts",
  find: "!isHostSessionRegistryAbsent(registry)",
  replace: "isHostSessionRegistryAbsent(registry) && !isHostSessionRegistryAbsent(registry)",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a valid argv selector when the registry path is replaced while its opened fd is read",
  ],
};
export default c;
