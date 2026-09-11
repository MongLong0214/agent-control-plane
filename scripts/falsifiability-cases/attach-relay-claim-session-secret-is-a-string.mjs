/**
 * The secret half of the same pair, mutated alone. The creation response is the only time a runtime
 * receives its session secret, so a receipt carrying something else is a protocol failure, not a
 * credential to try.
 */
const attachRelayClaimSessionSecretIsAString = {
  id: "attach-relay-claim-session-secret-is-a-string",
  what: "a receipt sessionSecret that is not a string never reaches the handshake",
  file: "src/cli/attach-relay.ts",
  find: "      if (typeof value.sessionId !== \"string\" || value.sessionId.length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      // The creation response is the only time a runtime ever receives its session secret\n      // (`src/session/session-registry.ts`). A receipt without one leaves nothing to present on\n      // the BOUND handshake, so it is a protocol failure rather than something to work around.\n      if (typeof value.sessionSecret !== \"string\" || value.sessionSecret.length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      finish({ kind: \"receipt\", sessionId: value.sessionId, sessionSecret: value.sessionSecret });\n",
  replace: "      if (typeof value.sessionId !== \"string\" || value.sessionId.length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      // The creation response is the only time a runtime ever receives its session secret\n      // (`src/session/session-registry.ts`). A receipt without one leaves nothing to present on\n      // the BOUND handshake, so it is a protocol failure rather than something to work around.\n      if ((value.sessionSecret as string).length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      finish({ kind: \"receipt\", sessionId: value.sessionId, sessionSecret: value.sessionSecret as string });\n",
  killedBy: ["tests/unit/attach-relay.test.ts::refuses a receipt whose sessionSecret is not a non-empty string before it reaches the mcp socket"],
};

export default attachRelayClaimSessionSecretIsAString;
