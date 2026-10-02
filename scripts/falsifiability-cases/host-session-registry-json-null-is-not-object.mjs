/** JSON `null` parses successfully but is not a usable registry object. */
const c = {
  id: "host-session-registry-json-null-is-not-object",
  what: "a registry file whose JSON is the literal null is refused as not an object",
  file: "src/registry/canonical-self-claim.ts",
  find: "entry === null",
  replace: "false",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses registry JSON that is not an object",
  ],
};
export default c;
