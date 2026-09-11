/**
 * Without this operand an empty code is reported as a refusal: `attach: handshake refused ` and
 * exit 4, where the relay in fact learned nothing about why the daemon said no.
 */
const attachRelayHandshakeRefusalCodeIsNotEmpty = {
  id: "attach-relay-handshake-refusal-code-is-not-empty",
  what: "a handshake refusal whose reasonCode is empty is a protocol failure, not a reported refusal",
  file: "src/cli/attach-relay.ts",
  find: " && body.reasonCode.length > 0",
  replace: "",
  killedBy: ["tests/unit/attach-relay.test.ts::reports a handshake refusal with no stable reason code as a protocol failure"],
};

export default attachRelayHandshakeRefusalCodeIsNotEmpty;
