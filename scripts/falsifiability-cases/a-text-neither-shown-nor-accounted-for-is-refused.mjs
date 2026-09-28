/**
 * A reading is refused when an arm's observations carry a text that is neither shown nor accounted
 * for.
 *
 * Withholding leaves exactly one way to drop model input without a reader noticing: an entry with
 * no text and no account -- no length, or a digest that is not a digest. The counts would then be
 * derived over what was left, every rule in this file would agree with every other, and nothing a
 * reader of the repository could see would say anything had been removed. So the acceptance rule
 * requires every text to be one or the other, and a hole is a shortfall.
 *
 * What it establishes is bounded, and the doc says so: that the record accounts for what it does not
 * show. Whether a withheld text says what its digest says needs the raw capture, which is under
 * `evidence/local/` and is not committed.
 *
 * The mutation relaxes the threshold to "negative", which a count of holes never is -- the shape a
 * boundary check fails in. The killing row feeds one arm a withheld entry with a digest that is not
 * a digest, then one with a negative length, and keeps the untouched arm as its control.
 */
const aTextNeitherShownNorAccountedForIsRefused = {
  id: "a-text-neither-shown-nor-accounted-for-is-refused",
  what: "a reading is refused when an arm's observations hold a model-input text that is neither recorded nor accounted for by a length and digest",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      if (unaccounted > 0) {\n",
  replace: "      if (unaccounted < 0) {\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm carrying a text it neither records nor accounts for is refused",
  ],
};

export default aTextNeitherShownNorAccountedForIsRefused;
