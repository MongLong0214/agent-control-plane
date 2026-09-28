/**
 * The CTO port reports a connected holder that declared no build at all, not only one that declared
 * a build outside the qualified set.
 *
 * `registerEndpoint` asks `isWakeTransportQualified`, which is false for no build, so that holder
 * is refused an endpoint and never receives a wake, exactly as one outside the set is. The scan
 * used to `continue` past it first: the one case in which the report had no build name to go on
 * was the one case it said nothing about, absence folded into the branch that means "fine". The
 * mutant puts that skip back, in the form the defect had.
 *
 * The killing row goes through the production entry: a real daemon, `startDaemonMcpListeners`, and
 * a peer on the real CTO socket whose `initialize` carries no `clientInfo`, then the daemon's own
 * system report, which must carry the finding with `presentedClient: null`.
 */
const aHolderThatDeclaredNoBuildIsReported = {
  id: "a-holder-that-declared-no-build-is-reported",
  what: "the CTO port reports a binding whose connected holder declared no client build",
  file: "src/mcp/role-conversation.ts",
  find: "      if (isWakeTransportQualified(client)) continue;\n",
  replace: "      if (client === undefined || isWakeTransportQualified(client)) continue;\n",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::reports a holder whose initialize declared no build, with presentedClient null and no path",
  ],
};

export default aHolderThatDeclaredNoBuildIsReported;
