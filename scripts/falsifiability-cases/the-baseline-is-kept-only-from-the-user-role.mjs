/**
 * The arm's prompt is evidence as a *user* text, not wherever it appears.
 *
 * The baseline asks whether this arm's prompt became a turn, and `baselineTurnObserved` asks it of
 * user messages only: the model's own words echoed back in an assistant turn are not evidence that
 * the prompt was accepted. The publication rule has to keep the same shape, or a reading publishes
 * a text no count reads -- an assistant turn quoting the prompt -- on the strength of a string
 * match, and the two halves of "kept means read" drift apart.
 *
 * The mutation keeps the prompt from any role. The killing row asks for an assistant echo to be
 * withheld and for the user text to be refused withholding, so it cannot pass by treating the two
 * alike in either direction.
 */
const theBaselineIsKeptOnlyFromTheUserRole = {
  id: "the-baseline-is-kept-only-from-the-user-role",
  what: "a text equal to the arm's prompt is kept verbatim only when it arrived as a user message",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "  (entry.text.includes(ROLE_WAKE_TOKEN) || (entry.from === \"user\" && entry.text.trim() === prompt));\n",
  replace: "  (entry.text.includes(ROLE_WAKE_TOKEN) || entry.text.trim() === prompt);\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::refuses to withhold a text carrying the token or equal to the prompt, rather than hiding it",
  ],
};

export default theBaselineIsKeptOnlyFromTheUserRole;
