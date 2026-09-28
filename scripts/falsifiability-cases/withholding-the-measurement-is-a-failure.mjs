/**
 * Being asked to withhold the measurement fails the run, rather than silently withholding it.
 *
 * `withholdText` is the only way a text becomes a length and a digest, and this is its refusal: a
 * text containing the wake token, or equal to the arm's prompt, is what every count in the reading
 * is read from, and recording one as "not this arm's evidence" would make the control arm's zero a
 * statement about what was published. Nothing on the production path asks for that -- the
 * classification routes evidence away from here -- which is exactly why the refusal matters: it is
 * what makes a later change to that classification stop the arm instead of quietly shrinking what
 * every reading shows.
 *
 * The mutation removes the refusal and leaves the record-building, so withholding evidence becomes
 * possible and silent. The killing row calls the writer directly with a token-carrying text and with
 * the prompt, requires both to throw, and requires an ordinary text to still be withheld with its
 * length and digest -- so it cannot pass by refusing everything.
 */
const withholdingTheMeasurementIsAFailure = {
  id: "withholding-the-measurement-is-a-failure",
  what: "the observation writer refuses to withhold a model-input text carrying the wake token or equal to the arm's prompt",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "  if (isArmEvidence(text, prompt)) {\n" +
    "    throw new Error(\n" +
    '      "a model-input text carrying the wake token, or equal to the arm\'s prompt, cannot be withheld: it is what the counts are read from",\n' +
    "    );\n" +
    "  }\n",
  replace: "  // the mutation: withhold whatever is asked, including the measurement\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::refuses to withhold a text carrying the token or equal to the prompt, rather than hiding it",
  ],
};

export default withholdingTheMeasurementIsAFailure;
