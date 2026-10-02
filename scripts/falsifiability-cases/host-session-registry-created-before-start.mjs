/** A registry file created before the ancestor's native start token belongs to an earlier process at the pid. */
const c = {
  id: "host-session-registry-created-before-start",
  what: "a registry file whose kernel creation time precedes the native start token is refused",
  file: "src/registry/canonical-self-claim.ts",
  find: "createdNs < startedNs",
  replace: "false",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a registry file created before the ancestor's native start token within the same procStart second",
  ],
};
export default c;
