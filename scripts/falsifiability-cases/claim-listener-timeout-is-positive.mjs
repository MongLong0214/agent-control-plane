/**
 * `Number.isInteger(0)` and `Number.isInteger(-1)` are both true, so the operand beside this one
 * admits both. Without this one the listener binds with a zero or negative budget, whose timer
 * fires on the tick it is armed: every claim is refused as having missed a deadline it never had.
 */
const claimListenerTimeoutIsPositive = {
  id: "claim-listener-timeout-is-positive",
  what: "the claim listener refuses a zero or negative request timeout before it binds a socket",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: " || requestTimeoutMs <= 0",
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses a zero and a negative request timeout, which an integer test admits",
  ],
};

export default claimListenerTimeoutIsPositive;
