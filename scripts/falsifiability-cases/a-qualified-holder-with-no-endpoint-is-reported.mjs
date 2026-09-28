/**
 * A holder on a qualified build that has registered no wake endpoint is reported, not skipped.
 *
 * This is the state the whole wake-transport slice exists to make visible, and it was the one state
 * the report was silent about: `unwakeableHolders` returned early on `isWakeTransportQualified`, so
 * a member build with no registration read as healthy. A reviewer ran the real port with exactly
 * that holder attached -- `endpointFor` returned null, `unwakeableHolders()` returned [], and
 * `wake()` refused with ROLE_PEER_UNSUPPORTED -- and the suite's "the control" row asserted the
 * silence, so the tests agreed with it.
 *
 * The mutation restores the silence at its new site: a qualified holder with no endpoint is a
 * holder with nothing wrong. The killing row is the daemon one, so what dies is the operator-facing
 * report through the production composition and not only the port's own answer.
 */
const aQualifiedHolderWithNoEndpointIsReported = {
  id: "a-qualified-holder-with-no-endpoint-is-reported",
  what: "the CTO port reports a holder on a qualified build that has registered no wake endpoint",
  file: "src/mcp/role-conversation.ts",
  find: '    if (endpoint === null) return "no-registered-endpoint";\n',
  replace: "    if (endpoint === null) return null;\n",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::reports a holder on a qualified build that has registered no wake endpoint",
  ],
};

export default aQualifiedHolderWithNoEndpointIsReported;
