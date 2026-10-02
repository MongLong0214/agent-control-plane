const c = {
  id: "host-session-registry-path-replacement",
  what: "a replaced registry path is refused after its original descriptor was read",
  file: "src/registry/canonical-self-claim.ts",
  find: "current.dev !== opened.dev || current.ino !== opened.ino",
  replace: "false",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses a regular registry path replaced while its opened fd is read"],
};
export default c;
