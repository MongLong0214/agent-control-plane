/**
 * `typeof [] === "object"`, so the operand beside this one admits every array. Without this one
 * an array `params` reaches the claim handler cast to `Record<string, unknown>`, where every
 * named field reads as absent rather than as a request that was never well formed.
 */
const claimSocketParamsAreNotAnArray = {
  id: "claim-socket-params-are-not-an-array",
  what: "array claim parameters are refused before the claim handler is called at all",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: " || Array.isArray(rawParams)",
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses an array params without ever calling the claim handler",
  ],
};

export default claimSocketParamsAreNotAnArray;
