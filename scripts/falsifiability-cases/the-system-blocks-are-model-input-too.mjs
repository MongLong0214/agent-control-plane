/**
 * The request's system blocks are read as model input, not only its messages.
 *
 * The control arm's criterion is that no turn in it carried the wake, and that claim is only as
 * wide as the places the count looks. A runtime that renders a peer message into the system
 * position -- which is a rendering decision the client owns, not a contract this harness has --
 * would satisfy the control while the model was told about the wake, and the injection arm would
 * report a delivery that did not happen.
 *
 * The mutation stops collecting the system blocks and leaves the message text alone, so every
 * capture on this host still counts exactly as it did: the token arrives in a user message here.
 * The killing row is the one witness that separates them -- a request whose system text carries
 * the token and whose messages are innocent.
 */
const theSystemBlocksAreModelInputToo = {
  id: "the-system-blocks-are-model-input-too",
  what: "the harness reads a request's system blocks as model input when it asks whether the wake reached the model",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: '  collect("system", request.system);\n',
  replace: '  collect("system", undefined);\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::a wake is counted where the model reads, so metadata is not a delivery and an escape is",
  ],
};

export default theSystemBlocksAreModelInputToo;
