/**
 * `PROVIDER_PIN_VARIABLE` says which environment variable *can* pin a provider. It does not say that
 * one *did*: `control-plane.ts:753` spreads `...overrides.gpt` after
 * `binary: process.env["ACP_CODEX_BINARY"]`, so a deployment's `adapterOptions` wins over the
 * environment. Telling that operator to repoint the variable names a setting whose value nothing
 * reads — the same send-you-to-the-wrong-place defect as `ACP_GPT_BINARY`, one layer out, and this
 * one cannot be fixed by a better table. The adapter cannot report where its `binary` came from;
 * `CliAdapterOptions.binary` is one string with no provenance. So the variable is named only when
 * its current value equals the pin in hand, and the sentence claims equality and nothing more —
 * `variableMatchingPin` carries why establishing provenance is not in this slice.
 *
 * The mutation drops that comparison and names the variable whenever the map has one, which is the
 * shape this started as and the shape a reader would reach for on the grounds that the map is
 * already keyed by provider. It compiles — `value` is still read by the guard above — and every
 * other row survives it, because in every other fixture the variable does hold the pin.
 */
const aPinSettingIsNamedOnlyWhenItOwnsThePin = {
  id: "a-pin-setting-is-named-only-when-it-owns-the-pin",
  what: "the repair names a pin's environment variable only when that variable's current value equals the pin being reported",
  file: "src/doctor/doctor.ts",
  find: "    return value === path || resolve(value) === path ? variable : undefined;",
  replace: "    return variable;",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::names the pin's setting only when that setting's value is the pin in hand",
  ],
};

export default aPinSettingIsNamedOnlyWhenItOwnsThePin;
