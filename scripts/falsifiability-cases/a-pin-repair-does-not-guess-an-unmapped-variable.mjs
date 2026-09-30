/**
 * The last expression in this check that could still derive an environment variable name from a
 * provider id. `PROVIDER_PIN_VARIABLE` is the table, and the message reaches for it once more in
 * the clause that names the variable a pin did *not* match. A provider absent from the table has
 * to fall through to a generic phrase there; deriving one instead re-enters the original defect
 * exactly — `ACP_GPT_BINARY` for the gpt provider, a variable nothing in this repository reads —
 * on the one line the earlier rows do not reach.
 *
 * No row covered this line until now. The assertion that was supposed to,
 * `not.toMatch(/ACP_[A-Z]+_BINARY at one/)`, named a phrase from the pre-repair message that the
 * repair had already deleted, so it passed for every message and every mutant. That is the fourth
 * time on this change that a check asked about something its subject merely appeared in.
 *
 * The mutation is the derived form. Measured against it: the message for an unmapped provider
 * reads "it is not the current value of ACP_PINNED_BINARY", and the witness fails on the generic
 * phrase it no longer contains. `ACP_*_BINARY` in the correct message does not satisfy
 * `/ACP_[A-Z]+_BINARY/`, because `*` is not `[A-Z]`.
 */
const aPinRepairDoesNotGuessAnUnmappedVariable = {
  id: "a-pin-repair-does-not-guess-an-unmapped-variable",
  what: "a provider absent from the pin-variable table gets a generic phrase, never a variable name derived from its id",
  file: "src/doctor/doctor.ts",
  find: '          `${PROVIDER_PIN_VARIABLE[provider] ?? "any ACP_*_BINARY variable"}, so this ` +',
  replace: "          `ACP_${provider.toUpperCase()}_BINARY, so this ` +",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::names no variable at all for a provider the map does not know",
  ],
};

export default aPinRepairDoesNotGuessAnUnmappedVariable;
