/**
 * R1041-02, round 2: while a handler in this process holds a message's claim open it may still answer,
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
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 waits for a handler this process still holds open instead of queueing beside its answer",
  ],
};

export default aLiveHandlerKeepsItsMessage;
