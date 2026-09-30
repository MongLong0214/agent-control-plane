/**
 * The baseline is the turn the arm's *own prompt* started, not any model request that happened.
 *
 * `baselineTurnObserved` used to ask only whether one request had reached the messages endpoint.
 * Reproduced by two reviewers on the exported function: an inference carrying an unrelated user
 * message was accepted, and so was a body with no messages in it at all. Either one lets the arm
 * proceed on a baseline that is not the prompt's turn, and `followUpAfterInjection` then compares
 * the wake against a count that never included the prompt -- so a session that never accepted the
 * prompt can report a pass.
 *
 * The mutation restores exactly that: existence of a model request, without asking whose turn it
 * was. The killing row feeds an unrelated inference, a body with no messages, and an assistant-role
 * echo of the prompt, and requires each to be refused -- with the real thing and a string-content
 * body kept as controls, so it is not a row that refuses everything.
 */
const theBaselineIsThePromptsOwnTurn = {
  id: "the-baseline-is-the-prompts-own-turn",
  what: "the harness accepts a baseline only from a model request that carries the prompt the arm was started with",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "  modelRequestsIn(capture).some((request) => userMessageTexts(request.body).some((text) => text.trim() === prompt));\n",
  replace: "  modelRequestsIn(capture).length > 0;\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::a request to that endpoint that is not this prompt's turn is not the baseline",
  ],
};

export default theBaselineIsThePromptsOwnTurn;
