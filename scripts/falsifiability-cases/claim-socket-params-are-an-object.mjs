/**
 * Without this operand a number `params` is handed to the claim handler as a
 * `Record<string, unknown>`, so a malformed request becomes the handler's problem instead of
 * being refused at the frame. The handler is the half that touches the registry.
 */
const claimSocketParamsAreAnObject = {
  id: "claim-socket-params-are-an-object",
  what: "non-object claim parameters are refused before the claim handler is called at all",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find: 'typeof rawParams !== "object" || ',
  replace: "",
  killedBy: [
    "tests/process/canonical-self-claim-listener-request-shape.test.ts::refuses a number params without ever calling the claim handler",
  ],
};

export default claimSocketParamsAreAnObject;
