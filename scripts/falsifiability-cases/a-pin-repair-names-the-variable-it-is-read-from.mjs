/**
 * #954, second round. The recommended action tells an operator which environment variable pins
 * this provider. That name was built by transformation — `ACP_` + the upper-cased provider id +
 * `_BINARY` — which is the correct answer for `claude` and for `grok` and wrong for the third:
 * `CodexCliAdapter.provider` is `"gpt"` while `ControlPlane` reads its pin from `ACP_CODEX_BINARY`
 * (`src/app/control-plane.ts:753`). `ACP_GPT_BINARY` occurs nowhere in this repository, so the
 * finding sent an operator to repoint a setting nothing consumes — the send-someone-to-the-wrong-
 * place failure this whole check exists to prevent, reproduced inside the check itself.
 *
 * The mutation is that transformation, restored verbatim. It is the shape a later simplification
 * would reach for, because the map looks like three lines of ceremony around a derivable string,
 * and two thirds of the evidence on screen agrees with it. This row exists so that simplification
 * dies rather than ships.
 *
 * The mutation now lands in `variableMatchingPin`, because that is where the name is looked up since the
 * message stopped naming a variable that does not own the pin in hand. The annotation
 * `: string | undefined` is not decoration: without it the `variable === undefined` guard below
 * becomes a comparison TypeScript rejects as impossible, and the harness typechecks every mutant,
 * so the row would report a compile failure instead of a verdict.
 *
 * Under the mutant, gpt's lookup answers `ACP_GPT_BINARY`, `process.env` has no such variable, and
 * `variableMatchingPin` therefore names nothing — so the repair for gpt loses `ACP_CODEX_BINARY`. It is
 * narrow: the finding is still produced, still non-blocking, still carries the same evidence.
 *
 * The witness must exercise the gpt provider. A test that checked `claude` alone passes under the
 * mutation, and that is exactly how the defect reached a green suite the first time.
 */
const aPinRepairNamesTheVariableItIsReadFrom = {
  id: "a-pin-repair-names-the-variable-it-is-read-from",
  what: "the repair names the environment variable the pin is actually read from, mapped rather than derived from the provider id",
  file: "src/doctor/doctor.ts",
  find: "    const variable = PROVIDER_PIN_VARIABLE[provider];",
  replace: "    const variable: string | undefined = `ACP_${provider.toUpperCase()}_BINARY`;",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::names the environment variable each provider's pin is actually read from",
  ],
};

export default aPinRepairNamesTheVariableItIsReadFrom;
