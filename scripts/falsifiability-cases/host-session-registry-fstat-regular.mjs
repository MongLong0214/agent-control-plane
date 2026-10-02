const c = {
  id: "host-session-registry-fstat-regular",
  what: "the opened registry descriptor is a regular file",
  file: "src/registry/canonical-self-claim.ts",
  find: "if (!opened.isFile()) return deny(ReasonCode.INVALID_ARGUMENT, `host session registry file is not regular: ${path}`);",
  replace: "if (false) return deny(ReasonCode.INVALID_ARGUMENT, `host session registry file is not regular: ${path}`);",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses a descriptor whose fstat says it is not regular"],
};
export default c;
