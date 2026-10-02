/** Only the reader's explicit absence marker counts as a missing registry file. */
const c = {
  id: "host-session-registry-absence-is-the-marker",
  what: "a registry refusal is benign absence only when it carries the absence marker",
  file: "src/registry/canonical-self-claim.ts",
  find: "registry.evidence[\"hostSessionRegistry\"] === HOST_SESSION_REGISTRY_ABSENT",
  replace: "true",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a valid argv selector when the registry path is replaced while its opened fd is read",
  ],
};
export default c;
