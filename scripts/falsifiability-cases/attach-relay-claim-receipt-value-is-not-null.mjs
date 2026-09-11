/**
 * Same shape one level down, and the same reason the neighbouring `typeof` operand cannot stand in
 * for it: a `null` value passes `typeof value !== "object"` and the next line reads `.sessionId`
 * off it.
 */
const attachRelayClaimReceiptValueIsNotNull = {
  id: "attach-relay-claim-receipt-value-is-not-null",
  what: "a receipt whose value is null is refused rather than read for a session field",
  file: "src/cli/attach-relay.ts",
  find: "      if (!value || typeof",
  replace: "      if (typeof",
  killedBy: ["tests/unit/attach-relay.test.ts::treats a receipt whose value is null as a protocol failure, never as a crash"],
};

export default attachRelayClaimReceiptValueIsNotNull;
