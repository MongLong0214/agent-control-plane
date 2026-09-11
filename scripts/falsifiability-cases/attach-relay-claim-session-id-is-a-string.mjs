/**
 * The mutation keeps the empty-string rejection and drops only the type rejection, so it is killed
 * by the non-string input alone. A number `sessionId` answers `.length` with `undefined`, which is
 * not `0`, so nothing else in this function stops it: it would be written into the handshake line
 * and come back as the daemon's own `MCP_PEER_UNAUTHENTICATED` — exit 4 where the receipt was the
 * thing at fault.
 *
 * The span reaches the receipt construction because this operand is the narrowing that line
 * depends on; no shorter isolated mutant type-checks.
 */
const attachRelayClaimSessionIdIsAString = {
  id: "attach-relay-claim-session-id-is-a-string",
  what: "a receipt sessionId that is not a string never reaches the handshake",
  file: "src/cli/attach-relay.ts",
  find: "      if (typeof value.sessionId !== \"string\" || value.sessionId.length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      // The creation response is the only time a runtime ever receives its session secret\n      // (`src/session/session-registry.ts`). A receipt without one leaves nothing to present on\n      // the BOUND handshake, so it is a protocol failure rather than something to work around.\n      if (typeof value.sessionSecret !== \"string\" || value.sessionSecret.length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      finish({ kind: \"receipt\", sessionId: value.sessionId, sessionSecret: value.sessionSecret });\n",
  replace: "      if ((value.sessionId as string).length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      // The creation response is the only time a runtime ever receives its session secret\n      // (`src/session/session-registry.ts`). A receipt without one leaves nothing to present on\n      // the BOUND handshake, so it is a protocol failure rather than something to work around.\n      if (typeof value.sessionSecret !== \"string\" || value.sessionSecret.length === 0) {\n        return finish({ kind: \"malformed\" });\n      }\n      finish({ kind: \"receipt\", sessionId: value.sessionId as string, sessionSecret: value.sessionSecret });\n",
  killedBy: ["tests/unit/attach-relay.test.ts::refuses a receipt whose sessionId is not a non-empty string before it reaches the mcp socket"],
};

export default attachRelayClaimSessionIdIsAString;
