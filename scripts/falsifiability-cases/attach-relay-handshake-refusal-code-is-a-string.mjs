/**
 * The same pair on the daemon's own answer to the relay's handshake. Without the type operand a
 * `{"ok":false,"reasonCode":["X"]}` line becomes `attach: handshake refused X` and exit 4, which
 * states a reason code that was never one.
 */
const attachRelayHandshakeRefusalCodeIsAString = {
  id: "attach-relay-handshake-refusal-code-is-a-string",
  what: "a handshake refusal whose reasonCode is not a string is a protocol failure, not a reported refusal",
  file: "src/cli/attach-relay.ts",
  find: "  return typeof body.reasonCode === \"string\" && body.reasonCode.length > 0\n    ? { kind: \"refusal\", reasonCode: body.reasonCode }",
  replace: "  return String(body.reasonCode).length > 0\n    ? { kind: \"refusal\", reasonCode: String(body.reasonCode) }",
  killedBy: ["tests/unit/attach-relay.test.ts::reports a handshake refusal with no stable reason code as a protocol failure"],
};

export default attachRelayHandshakeRefusalCodeIsAString;
