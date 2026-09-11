/**
 * `typeof [] === "object"`, so the operand beside this one admits every array. Without this one
 * an array request line reaches the method check and is refused as a bad method name rather than
 * as a request that is not an object at all.
 */
const claimSocketRequestLineIsNotAnArray = {
  id: "claim-socket-request-line-is-not-an-array",
  what: "an array request line on the claim socket is refused as a non-object, not as a bad method",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: " || Array.isArray(value)",
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses an array request line as an invalid argument, never as an unrecognized method",
  ],
};

export default claimSocketRequestLineIsNotAnArray;
