/**
 * #954. The doctor's readback is only as good as the value the adapter hands it, and every other
 * row in this directory drives a test double. If the three shipped CLI adapters answered with
 * anything but the path they resolved — or with nothing — the check would run, find nothing, and
 * report a healthy deployment on exactly the failure it was written for.
 *
 * The mutation returns a path instead of the pin: `process.execPath` exists and is executable, so
 * a doctor run over the mutant still produces no finding and still looks correct. Only the
 * adapter's own claim about what it will spawn is false, which is the property this row is about.
 * `ClaudeCliAdapter` is the one anchored because its accessor carries the full #954 docstring and
 * is therefore unique in the file; the Codex and Grok accessors are textually identical to each
 * other and point at this one.
 */
const aCliAdapterHandsOutItsOwnPin = {
  id: "a-cli-adapter-hands-out-its-own-pin",
  what: "a CLI adapter's executablePath is the binary it resolved, so the doctor reads the path that will actually be spawned",
  file: "src/runtime/cli-adapters.ts",
  find: "  get executablePath(): string {\n    return this.#binary;\n  }\n\n  async startSession(spec: SessionSpec): Promise<SessionHandle> {\n    // Claude Code is invoked per turn in headless mode;",
  replace: "  get executablePath(): string {\n    return process.execPath;\n  }\n\n  async startSession(spec: SessionSpec): Promise<SessionHandle> {\n    // Claude Code is invoked per turn in headless mode;",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::is the pin the real CLI adapters resolved, carried through the registry's wrapper",
  ],
};

export default aCliAdapterHandsOutItsOwnPin;
