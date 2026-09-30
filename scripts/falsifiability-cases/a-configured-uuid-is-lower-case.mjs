/**
 * Review #1006/sol ACP1006-R1-01, second half. `UUID_PATTERN` admits `A-F`, and the session UUID
 * this primitive resolves membership against is lowercased where it is read out of the claude
 * ancestor's argv. An upper-case configured entry therefore parsed, passed every other check,
 * started the daemon, and then refused its own session with CONFLICT for as long as it was
 * deployed — a configuration error that could only ever be diagnosed at claim time.
 */
const c = {
  id: "a-configured-uuid-is-lower-case",
  what: "a configured sessionUuid that no derived UUID could ever equal constructs nothing",
  file: "src/registry/canonical-self-claim.ts",
  find: "    if (configuredUuid !== configuredUuid.toLowerCase()) {",
  replace: "    if (configuredUuid !== configuredUuid.toLowerCase() && false) {",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::fails closed on an upper-case configured sessionUuid, which can never match a derived one",
  ],
};
export default c;
