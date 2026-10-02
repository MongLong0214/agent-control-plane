/** A registry sessionId is compared in lower case; the fixture uses hex letters so the mutation is visible. */
const c = {
  id: "host-session-registry-lowercases-uuid",
  what: "a valid registry sessionId is lowercased before it is compared",
  file: "src/registry/canonical-self-claim.ts",
  find: "fields.sessionId.toLowerCase()",
  replace: "fields.sessionId",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::lowercases only a valid derived registry UUID",
  ],
};
export default c;
