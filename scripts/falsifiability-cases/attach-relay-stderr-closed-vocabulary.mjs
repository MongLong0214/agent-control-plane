/**
 * stderr is a log wherever Claude Code files it, so the relay's vocabulary there is closed to the
 * stage and the daemon's own stable reason code. Widening it to the claim outcome is how a receipt
 * field — the session secret among them, on a real receipt — reaches a file on disk.
 */
const attachRelayStderrClosedVocabulary = {
  id: "attach-relay-stderr-closed-vocabulary",
  what: "the relay's stderr carries the stage and the reason code, and nothing else",
  file: "src/cli/attach-relay.ts",
  find: "    io.stderr.write(`attach: claim refused ${claimed.reasonCode}\\n`);",
  replace: "    io.stderr.write(`attach: claim refused ${claimed.reasonCode} ${JSON.stringify(claimed)}\\n`);",
  killedBy: ["tests/unit/attach-relay.test.ts::reaches no mcp socket at all when the claim is refused, and reports only the reason code"],
};

export default attachRelayStderrClosedVocabulary;
