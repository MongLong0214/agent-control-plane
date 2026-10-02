const c = {
  id: "host-session-registry-start-token-stable",
  what: "the Claude ancestor kernel start token is identical before and after the registry read",
  file: "src/registry/canonical-self-claim.ts",
  find: "afterRead !== snapshot.startedAt",
  replace: "afterRead === snapshot.startedAt",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses a registry when the ancestor kernel start token changes during its read"],
};
export default c;
