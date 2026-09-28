/**
 * An arm's "before the frame" is the boundary it recorded, not the position of its prompt's turn.
 *
 * This is the defect that shipped. Deriving the counts from the committed observations closed a
 * real gap -- a count that stood on nothing -- and lost the one fact the live probe had that the
 * record did not: *when the frame was written*. `countsFrom` reconstructed it by taking the
 * position of the turn carrying the arm's prompt, which answers a different question. A reviewer
 * drove the real probe against a session that emits its prompt, then a turn carrying the wake token
 * of its own accord, and then ignores the injected frame: the token-bearing turn sat after the
 * prompt's turn, so it was read as the follow-up the frame caused, and all four arms were admitted.
 * The ceremony passed a build that ignores the wake.
 *
 * The mutation is exactly that reconstruction, restored. The killing rows are the reviewer's
 * session in both forms -- as a record, where the same two requests pass or fail on which side of
 * the boundary the frame is recorded at, and through the real probe in both shapes.
 */
const theBoundaryIsRecordedNotReconstructed = {
  id: "the-boundary-is-recorded-not-reconstructed",
  what: "the counts split an arm's requests at the boundary it recorded, rather than at the position of the turn carrying its prompt",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "  const at = (observations?.boundary ?? {}).requestsBefore;\n" +
    "  if (typeof at !== \"number\" || !Number.isInteger(at) || at < 0) return requests.length;\n" +
    "  return Math.min(at, requests.length);\n",
  replace:
    "  const promptAt = requests.findIndex(\n" +
    "    (request) =>\n" +
    "      isObservedTurn(request) &&\n" +
    "      keptTexts(request).some(({ from, text }) => from === \"user\" && text.trim() === BASELINE_PROMPT),\n" +
    "  );\n" +
    "  return promptAt < 0 ? 0 : promptAt + 1;\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::a turn that preceded the frame is not the follow-up the frame caused",
  ],
};

export default theBoundaryIsRecordedNotReconstructed;
