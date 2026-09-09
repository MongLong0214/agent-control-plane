const anUnboundSubscriberDoesNotEndDaemonStartup = {
  id: "an-unbound-subscriber-does-not-end-daemon-startup",
  what: "an unbound subscriber does not end daemon startup",
  file: "src/daemon/agentcpd.ts",
  find: "    if (!(error instanceof BuzzMentionBindingUnavailableError)) throw error;\n" +
    "    // Dead-binding recovery deliberately leaves the role unbound. Keep the claim door\n" +
    "    // available, while preserving the subscriber's all-or-none preflight and delivery checks.\n" +
    "    process.stderr.write(\n" +
    "      `Buzz mention subscriber refused: ${error.message}; continuing without Buzz mention subscriber. ` +\n" +
    "        \"After a fresh role claim, restart the daemon to enable mentions.\\n\",\n" +
    "    );\n" +
    "    return null;",
  replace: "    throw error;",
  killedBy: [
    "tests/unit/daemon-subscriber-unbound.test.ts::completes daemon startup with a revoked PRIMARY_CTO binding and keeps the claim door open",
  ],
};

export default anUnboundSubscriberDoesNotEndDaemonStartup;
