/** A registry sessionId that is a string but not an exact UUID must still be refused. */
const c = {
  id: "host-session-registry-sessionid-must-be-uuid-shaped",
  what: "a non-UUID-shaped registry sessionId is refused even though it is a string",
  file: "src/registry/canonical-self-claim.ts",
  find: "!UUID_PATTERN.test(fields.sessionId)",
  replace: "false",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a non-UUID registry sessionId",
  ],
};
export default c;
