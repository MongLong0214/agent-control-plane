/**
 * `typeof null` is `"object"`, so the operand beside this one cannot catch a `null` body. Without
 * it the next line reads `.allowed` off `null` and the relay dies with a TypeError on the stderr
 * Claude Code files as its MCP server log — a dead stdio server instead of a typed exit 6.
 */
const attachRelayClaimBodyIsNotNull = {
  id: "attach-relay-claim-body-is-not-null",
  what: "a claim response body of null is refused rather than read for a field",
  file: "src/cli/attach-relay.ts",
  find: "      if (!parsed || typeof",
  replace: "      if (typeof",
  killedBy: ["tests/unit/attach-relay.test.ts::treats a claim response body that is not an object as a protocol failure, never as a crash"],
};

export default attachRelayClaimBodyIsNotNull;
