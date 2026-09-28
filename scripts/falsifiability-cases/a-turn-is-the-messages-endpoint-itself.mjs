/**
 * A request counts as a turn only if it was sent to `/v1/messages` itself.
 *
 * The filter was `url.includes("/v1/messages")`, which also matches `/v1/messages/count_tokens` --
 * a request *about* a turn, which a client can send before it has asked for any inference. The
 * interactive arm no longer types: its prompt is a positional argument, and the captured model
 * request is the only evidence that the client accepted it. A count-tokens request standing in for
 * that evidence lets the arm proceed and then compare the wake's follow-up against a baseline that
 * never happened, so a session that never turned at all can report a pass.
 *
 * The mutation restores the substring test. The killing row feeds a capture holding only
 * count-tokens requests, with and without a query string, and requires "no turn seen" -- and keeps
 * the endpoint itself as its control, so it is not a row that refuses everything.
 */
const aTurnIsTheMessagesEndpointItself = {
  id: "a-turn-is-the-messages-endpoint-itself",
  what: "the harness counts a request as a turn only when its endpoint is /v1/messages, not when the path merely contains it",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '    (request) => request.method === "POST" && requestEndpoint(request.url) === MESSAGES_ENDPOINT,\n',
  replace: '    (request) => request.method === "POST" && request.url.includes(MESSAGES_ENDPOINT),\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::a count-tokens request is a request about a turn, and is not one",
  ],
};

export default aTurnIsTheMessagesEndpointItself;
