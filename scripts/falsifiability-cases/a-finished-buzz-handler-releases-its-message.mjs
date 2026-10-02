/**
 * R1041-04: a handler that finished on a timeout leaves its claim open by design, and must not keep its
 * message held as if it were still answering.
 */
const aFinishedBuzzHandlerReleasesItsMessage = {
  id: "a-finished-buzz-handler-releases-its-message",
  what: "a Buzz handler that finished is no longer registered as running",
  file: "src/ingress/buzz-message.ts",
  find: "  const resolution = closes ? ingress.resolveTurn(admitted.nonce) : null;\n  handling.end();",
  replace: "  const resolution = closes ? ingress.resolveTurn(admitted.nonce) : null;\n  void handling;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-04 settles a turn whose Buzz handler finished on a timeout",
  ],
};

export default aFinishedBuzzHandlerReleasesItsMessage;
