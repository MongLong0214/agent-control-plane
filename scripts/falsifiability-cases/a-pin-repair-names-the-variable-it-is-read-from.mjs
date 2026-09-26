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
 * It compiles: `noUnusedLocals` is not set in `tsconfig.json`, so the now-unreferenced `variable`
 * binding and `PROVIDER_PIN_VARIABLE` map do not fail the harness's `tsc --noEmit` pass, and the
 * mutant runs. It is also narrow — the finding is still produced, still non-blocking, still
 * carries the same evidence; only the variable named in the prose changes. Every other row in
 * this directory survives it, which is what isolates this one to the property it claims.
 *
 * The witness must exercise the gpt provider. A test that checked `claude` alone passes under the
 * mutation, and that is exactly how the defect reached a green suite the first time.
 */
const aPinRepairNamesTheVariableItIsReadFrom = {
  id: "a-pin-repair-names-the-variable-it-is-read-from",
  what: "the repair names the environment variable the pin is actually read from, mapped rather than derived from the provider id",
  file: "src/doctor/doctor.ts",
  find: '          `${variable ?? "whichever setting pins this provider"} at one — and then restart the ` +',
  replace: "          `ACP_${adapter.provider.toUpperCase()}_BINARY at one — and then restart the ` +",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::names the environment variable each provider's pin is actually read from",
  ],
};

export default aPinRepairNamesTheVariableItIsReadFrom;
