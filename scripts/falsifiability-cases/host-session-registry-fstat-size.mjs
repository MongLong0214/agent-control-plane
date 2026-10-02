const c = {
  id: "host-session-registry-fstat-size",
  what: "the opened registry descriptor is within the size bound",
  file: "src/registry/canonical-self-claim.ts",
  find: "size <= HOST_SESSION_REGISTRY_MAX_BYTES",
  replace: "true",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses an oversized registry file"],
};
export default c;
