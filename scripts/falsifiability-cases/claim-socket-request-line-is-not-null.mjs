/**
 * `typeof null === "object"` and `Array.isArray(null)` is false, so neither operand beside this
 * one can catch a `null` request line. Without it the next statement reads `.method` off `null`
 * and the connection gets a thrown TypeError where a typed `INVALID_ARGUMENT` refusal belongs.
 */
const claimSocketRequestLineIsNotNull = {
  id: "claim-socket-request-line-is-not-null",
  what: "a null request line on the claim socket is refused, never dereferenced for a method name",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: "if (!value || typeof",
  replace: "if (typeof",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses a null request line rather than reading a method name off it",
  ],
};

export default claimSocketRequestLineIsNotNull;
