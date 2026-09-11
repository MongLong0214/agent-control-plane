/**
 * The empty string is a string, so only this operand rejects it. Without it the relay writes
 * `attach: claim refused ` and exits 3 — a refusal reported with no reason at all.
 */
const attachRelayClaimRefusalCodeIsNotEmpty = {
  id: "attach-relay-claim-refusal-code-is-not-empty",
  what: "a claim denial whose reasonCode is empty is a protocol failure, not a reported refusal",
  file: "src/cli/attach-relay.ts",
  find: " && response.reasonCode.length > 0",
  replace: "",
  killedBy: ["tests/unit/attach-relay.test.ts::reports a claim denial with no stable reason code as a protocol failure, not as a refusal"],
};

export default attachRelayClaimRefusalCodeIsNotEmpty;
