/**
 * The other half, mutated alone: an empty `sessionId` is a string, so the type operand beside this
 * one passes it through to a handshake the daemon then refuses.
 */
const attachRelayClaimSessionIdIsNotEmpty = {
  id: "attach-relay-claim-session-id-is-not-empty",
  what: "a receipt sessionId that is the empty string never reaches the handshake",
  file: "src/cli/attach-relay.ts",
  find: " || value.sessionId.length === 0",
  replace: "",
  killedBy: ["tests/unit/attach-relay.test.ts::refuses a receipt whose sessionId is not a non-empty string before it reaches the mcp socket"],
};

export default attachRelayClaimSessionIdIsNotEmpty;
