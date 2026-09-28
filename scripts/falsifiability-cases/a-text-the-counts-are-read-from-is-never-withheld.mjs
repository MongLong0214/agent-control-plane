/**
 * A text this arm's counts are read from is kept verbatim in the committed record, never withheld.
 *
 * The readings go into a public repository, so a committed observation shows only what the counts
 * are read from -- the arm's prompt, and any text carrying the wake token -- and records every other
 * text as a length and a digest. That is the client's system prompt, which is not ours to republish,
 * and it is most of the bytes.
 *
 * What the withholding must never reach is the measurement itself. The control arm's whole claim is
 * that no text the model was given carried the token; if a token-carrying text could be classified
 * as "not evidence", that zero would describe what was published rather than what was measured, and
 * the injection arm's positive count would lose the prose that shows the delivery.
 *
 * The mutation narrows the classification to equality with the prompt, which is what a substring
 * search over prose looks like when someone decides it is too broad -- and it sends every
 * wake-carrying text to the withholding side. The killing row requires that the prose the runtime
 * composes around the token comes back in full, beside the two texts that do not and are accounted
 * for by digest.
 */
const aTextTheCountsAreReadFromIsNeverWithheld = {
  id: "a-text-the-counts-are-read-from-is-never-withheld",
  what: "a committed observation keeps verbatim every model-input text the arm's counts are read from",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "  text.includes(ROLE_WAKE_TOKEN) || text.trim() === prompt;\n",
  replace: "  text.trim() === prompt;\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::keeps the texts its counts are read from, and withholds every other by kind, length and digest",
  ],
};

export default aTextTheCountsAreReadFromIsNeverWithheld;
