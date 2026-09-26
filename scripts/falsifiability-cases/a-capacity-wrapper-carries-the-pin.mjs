/**
 * #954. `ProviderRegistry.list()` and `production()` hand out `CapacityObservedAdapter`, never the
 * adapter itself, so every caller that asks the registry for a provider is asking the wrapper. A
 * wrapper that did not forward the pin would answer `undefined` for all three CLI adapters, and
 * `undefined` means "this adapter spawns nothing" — the doctor would skip every real provider and
 * report a clean sweep, with no test failing anywhere to say the readback had gone silent.
 *
 * This is the quietest way the whole change could stop working, which is why it has a row of its
 * own rather than riding on the doctor's rows: the mutation below leaves the accessor present on
 * the interface, present on the three adapters, and present in the doctor, and still produces a
 * deployment where nothing is ever checked.
 */
const aCapacityWrapperCarriesThePin = {
  id: "a-capacity-wrapper-carries-the-pin",
  what: "the capacity-observed wrapper the registry hands out forwards the adapter's pinned executable",
  file: "src/runtime/provider.ts",
  find: "  get executablePath(): string | undefined {\n    return this.inner.executablePath;\n  }",
  replace: "  get executablePath(): string | undefined {\n    return undefined;\n  }",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::is the pin the real CLI adapters resolved, carried through the registry's wrapper",
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::reports a stable name whose versioned target the updater pruned",
  ],
};

export default aCapacityWrapperCarriesThePin;
