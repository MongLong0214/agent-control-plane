const anUnboundSubscriberDoesNotEndDaemonStartup = {
  id: "an-unbound-subscriber-does-not-end-daemon-startup",
  what: "an unbound subscriber does not end daemon startup",
  file: "src/daemon/agentcpd.ts",
  find: "    if (!(error instanceof BuzzMentionBindingUnavailableError)) throw error;",
  replace: "    throw error;",
  killedBy: [
    "tests/unit/daemon-subscriber-unbound.test.ts::completes daemon startup with a revoked PRIMARY_CTO binding and keeps the claim door open",
  ],
};

export default anUnboundSubscriberDoesNotEndDaemonStartup;
