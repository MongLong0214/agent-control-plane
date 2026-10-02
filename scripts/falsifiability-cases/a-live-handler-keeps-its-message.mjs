/**
 * R1041-02, round 2: while a handler in this process is running for a message it may still answer,
 * so a receipt-created obligation waits rather than queueing beside that answer. The replacement keeps
 * `inFlight` narrowed so the mutant compiles; no real nonce is empty.
 */
const aLiveHandlerKeepsItsMessage = {
  id: "a-live-handler-keeps-its-message",
  what: "a message a live handler still holds open is not given a queued reply",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (inFlight !== undefined) {",
  replace: "  if (inFlight?.nonce === \"\") {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 waits for a Buzz handler that is still running instead of queueing beside its answer",
  ],
};

export default aLiveHandlerKeepsItsMessage;
