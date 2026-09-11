/**
 * The mutation stringifies instead of type-checking, so an empty code is still refused and only the
 * non-string input kills it. `["X"]` answers `.length` with 1, so without the type operand the relay
 * prints `attach: claim refused X` — a reason code no catalogue declares, on the stderr that is
 * supposed to carry only the daemon's own.
 */
const attachRelayClaimRefusalCodeIsAString = {
  id: "attach-relay-claim-refusal-code-is-a-string",
  what: "a claim denial whose reasonCode is not a string is a protocol failure, not a reported refusal",
  file: "src/cli/attach-relay.ts",
  find: "        return typeof response.reasonCode === \"string\" && response.reasonCode.length > 0\n          ? finish({ kind: \"refused\", reasonCode: response.reasonCode })",
  replace: "        return String(response.reasonCode).length > 0\n          ? finish({ kind: \"refused\", reasonCode: String(response.reasonCode) })",
  killedBy: ["tests/unit/attach-relay.test.ts::reports a claim denial with no stable reason code as a protocol failure, not as a refusal"],
};

export default attachRelayClaimRefusalCodeIsAString;
