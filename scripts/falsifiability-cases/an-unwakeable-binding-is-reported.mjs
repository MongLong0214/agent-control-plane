/**
 * The CTO port names a connected holder whose declared build is outside the qualified set.
 *
 * That holder's binding is ACTIVE and its peer is live, and it still cannot register a wake
 * endpoint, so it never receives a wake and an addressed message waits for a registration that will
 * not come. The only symptom is silence. The mutant asks membership of a set holding only the
 * holder's own build, so every holder that declared a build counts as qualified, members and
 * non-members alike; the port reports nothing for any of them and the daemon's finding never fires
 * for a build outside the set — the silence returns, now with a check beside it that looks like
 * coverage.
 *
 * Written that way because the obvious mutant does not compile: `if (client) continue;` narrows
 * `client` to `never` on the next line, so tsc refused it (measured). Re-derived when the scan
 * stopped skipping a holder that declared no build: `client` then reaches this line possibly
 * undefined, so `[client]` alone no longer typechecks as a member list, and the mutant builds the
 * list only from a declared build.
 *
 * The killing row attaches one holder outside the set and one that declared no build to a port, and
 * asserts each one's cause. Since the scan stopped returning early on a qualified build, a mutant
 * here no longer silences the report entirely -- the holder falls through to the endpoint checks and
 * is reported as having registered none -- so what the row measures is the *cause*: a holder outside
 * the qualified set has to be reported as outside it, because that is the only cause whose repair
 * is a different build.
 */
const anUnwakeableBindingIsReported = {
  id: "an-unwakeable-binding-is-reported",
  what: "the CTO port reports a binding whose connected holder declared a build outside the qualified set",
  file: "src/mcp/role-conversation.ts",
  find:
    "    if (!isWakeTransportQualified(client)) {\n" +
    '      return client ? "build-outside-the-qualified-set" : "no-declared-build";\n',
  replace:
    "    if (!isWakeTransportQualified(client, client ? [client] : [])) {\n" +
    '      return client ? "build-outside-the-qualified-set" : "no-declared-build";\n',
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::reports a holder on a build outside the set and one that declared no build, each with its cause",
  ],
};

export default anUnwakeableBindingIsReported;
