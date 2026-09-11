/**
 * `1.5 <= 0` is false and `NaN <= 0` is false, so the comparison beside this operand admits both.
 * Without this one the listener binds its socket and arms a fractional or NaN `setTimeout`, which
 * is a request budget nobody declared on the one socket that grants PRIMARY_CTO.
 */
const claimListenerTimeoutIsAnInteger = {
  id: "claim-listener-timeout-is-an-integer",
  what: "the claim listener refuses a fractional or NaN request timeout before it binds a socket",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: "!Number.isInteger(requestTimeoutMs) || ",
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses a fractional request timeout, which no comparison against zero can catch",
  ],
};

export default claimListenerTimeoutIsAnInteger;
