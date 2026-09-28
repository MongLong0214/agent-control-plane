/**
 * A request counts as a turn only if it asked for inference: a POST.
 *
 * The fake provider answers a GET to the same path with a 404, so a non-POST request got no
 * completion and began no turn. A reviewer reproduced the gap by feeding an empty
 * `GET /v1/messages` to the exported predicate, which accepted it as the baseline. The same count
 * is what `followUpAfterInjection` reads, so a stray non-POST after the frame would also read as
 * the wake's follow-up.
 *
 * The mutation drops the method comparison and keeps the endpoint one. The killing row asks
 * `modelRequestsIn` for a GET carrying a perfectly good prompt body and requires it to be empty,
 * so the row cannot be satisfied by the body test standing in for the method test.
 */
const aTurnIsARequestThatAskedForInference = {
  id: "a-turn-is-a-request-that-asked-for-inference",
  what: "the harness counts a captured request as a turn only when it was a POST, not merely when it reached the messages endpoint",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '    (request) => request.method === "POST" && requestEndpoint(request.url) === MESSAGES_ENDPOINT,\n',
  replace: "    (request) => requestEndpoint(request.url) === MESSAGES_ENDPOINT,\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::a request to that endpoint that is not this prompt's turn is not the baseline",
  ],
};

export default aTurnIsARequestThatAskedForInference;
