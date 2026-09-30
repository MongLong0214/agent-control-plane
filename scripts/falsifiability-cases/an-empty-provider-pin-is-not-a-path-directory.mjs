/**
 * #954. An explicitly empty provider pin names no executable. Without this return,
 * `join(directory, "")` turns the first searchable PATH directory into the adapter's pin and the
 * doctor reports that directory as NOT_A_FILE, sending the operator to repair a path nobody set.
 *
 * The witness composes the shipped role-scoped Claude adapters through ControlPlane. A direct
 * helper test would miss the provider enumeration shape that previously hid this readback.
 */
const anEmptyProviderPinIsNotAPathDirectory = {
  id: "an-empty-provider-pin-is-not-a-path-directory",
  what: "an explicitly empty provider pin remains empty instead of resolving to a PATH directory",
  file: "src/runtime/cli-adapters.ts",
  find: '  if (binary === "") return binary;\n',
  replace: "",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::reports an explicitly empty provider pin as not configured",
  ],
};

export default anEmptyProviderPinIsNotAPathDirectory;
