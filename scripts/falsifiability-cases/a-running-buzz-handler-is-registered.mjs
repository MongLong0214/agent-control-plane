/**
 * R1041-02/04: the Buzz handler hands its answer to the relay inline, with nothing durable in between,
 * so it registers while it runs and a receipt-created obligation waits for it.
 */
const aRunningBuzzHandlerIsRegistered = {
  id: "a-running-buzz-handler-is-registered",
  what: "a Buzz handler is registered as running while it waits for the CEO",
  file: "src/ingress/buzz-message.ts",
  find: "  const handling = ingress.beginTurnHandler(admitted.nonce);",
  replace: "  const handling = { end: (): void => undefined };",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 waits for a Buzz handler that is still running instead of queueing beside its answer",
  ],
};

export default aRunningBuzzHandlerIsRegistered;
