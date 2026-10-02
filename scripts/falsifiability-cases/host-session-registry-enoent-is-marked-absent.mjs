/** A missing registry file is reported with the absence marker, so a valid argv selector still stands alone. */
const c = {
  id: "host-session-registry-enoent-is-marked-absent",
  what: "ENOENT opening the registry is reported through the absence marker",
  file: "src/registry/canonical-self-claim.ts",
  find: "return hostSessionRegistryAbsent(`host session registry file is absent: ${path}`);",
  replace: "return deny(ReasonCode.NOT_FOUND, `host session registry file is absent: ${path}`);",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::allows an argv selector when the registry file is absent",
  ],
};
export default c;
