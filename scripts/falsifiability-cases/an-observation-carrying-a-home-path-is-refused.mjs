/**
 * A capture carrying an account's home directory stops the arm rather than being committed.
 *
 * The observations go into a committed file, and a request body is prose a client composed: a
 * working directory in a system prompt puts a home path in the middle of a string, where
 * `redactHome` -- which replaces the prefix of a string that *is* a path -- does not reach it. A
 * username published to every reader of the repository is not a defect this can leave to a later
 * reviewer, so what cannot be redacted refuses.
 *
 * The mutation redacts and commits whatever survives. The killing row feeds a system prompt naming
 * another account's home and requires a throw, and keeps a temp-root path as its control so it is
 * not a check that refuses every path.
 */
const anObservationCarryingAHomePathIsRefused = {
  id: "an-observation-carrying-a-home-path-is-refused",
  what: "the harness refuses to build an observation record from a capture carrying a home-directory path",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "    if (HOME_PATH.test(redacted)) {\n" +
    '      throw new Error("a captured request carries a home-directory path that redactHome did not reach");\n' +
    "    }\n",
  replace: "",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::refuses a capture carrying a home-directory path rather than committing one",
  ],
};

export default anObservationCarryingAHomePathIsRefused;
