/**
 * A reading carrying a verbatim model-input text that none of its counts are read from is refused.
 *
 * These readings are committed to a public repository, and most of what a request puts in front of
 * the model is the client's own system prompt: vendor product text, and the kind of provider and
 * model detail that does not belong in a public artefact. The instrument withholds all of it and
 * keeps only what the counts are read from -- the arm's prompt, and any text carrying the wake token.
 *
 * That is a property of the code that wrote the file. This row is the property of the **file**: a
 * reading taken by some other instrument, taken before this rule existed, or edited afterwards,
 * publishes that text and every other rule here agrees with it, because the counts are unaffected by
 * a text no count reads. Without this, the first artefact to republish a system prompt would be
 * admitted by a gate that had just been changed to prevent exactly that.
 *
 * The mutation relaxes the threshold to "negative", which a count of published texts never is -- the
 * shape a boundary check fails in. The killing row adds one verbatim system text to an arm whose
 * record is otherwise the instrument's own, and keeps that untouched arm as its control, so the row
 * cannot pass by refusing every reading.
 */
const aReadingPublishingWhatItDoesNotReadIsRefused = {
  id: "a-reading-publishing-what-it-does-not-read-is-refused",
  what: "a reading is refused when an arm's observations carry a verbatim model-input text that none of its counts are read from",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      if (published > 0) {\n",
  replace: "      if (published < 0) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm publishing a text none of its counts are read from is refused",
  ],
};

export default aReadingPublishingWhatItDoesNotReadIsRefused;
