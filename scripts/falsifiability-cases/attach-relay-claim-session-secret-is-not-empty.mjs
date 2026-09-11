/**
 * An empty secret is a string and would be written to the handshake line verbatim. The daemon
 * refuses it, but by then the relay has presented a credential it could have known was not one.
 */
const attachRelayClaimSessionSecretIsNotEmpty = {
  id: "attach-relay-claim-session-secret-is-not-empty",
  what: "a receipt sessionSecret that is the empty string never reaches the handshake",
  file: "src/cli/attach-relay.ts",
  find: " || value.sessionSecret.length === 0",
  replace: "",
  killedBy: ["tests/unit/attach-relay.test.ts::refuses a receipt whose sessionSecret is not a non-empty string before it reaches the mcp socket"],
};

export default attachRelayClaimSessionSecretIsNotEmpty;
