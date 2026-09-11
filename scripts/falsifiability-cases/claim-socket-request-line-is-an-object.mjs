/**
 * Without this operand a number or a string request line reaches the method check, where
 * `(42).method` is `undefined` and the caller is refused with `OPERATOR_METHOD_NOT_ALLOWED` — a
 * refusal naming the method of a request that never had one. The two reason codes are the whole
 * observable an operator gets on this socket, so the wrong one is the defect.
 */
const claimSocketRequestLineIsAnObject = {
  id: "claim-socket-request-line-is-an-object",
  what: "a non-object request line on the claim socket is an invalid argument, not an unrecognized method",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: 'typeof value !== "object" || ',
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses a number request line as an invalid argument, never as an unrecognized method",
  ],
};

export default claimSocketRequestLineIsAnObject;
