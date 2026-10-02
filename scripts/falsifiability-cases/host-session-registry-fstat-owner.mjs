const c = {
  id: "host-session-registry-fstat-owner",
  what: "the opened registry descriptor belongs to the daemon uid",
  file: "src/registry/canonical-self-claim.ts",
  find: "if (uid === undefined || opened.uid !== uid) {",
  replace: "if (false) {",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses an opened descriptor whose fstat uid differs from the daemon"],
};
export default c;
