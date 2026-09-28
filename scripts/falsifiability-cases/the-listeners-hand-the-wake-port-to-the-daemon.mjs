/**
 * `startDaemonMcpListeners` hands the CTO wake port to the daemon's report.
 *
 * The setter is optional in that function's parameter type because several callers pass a bare
 * `finalizeApprovedRun` object, so TypeScript cannot say whether the line is there: without it the
 * daemon's `#wakeTransportPeers` stays null and the finding never fires, with every piece of it
 * individually correct. The killing row goes through this function with a real `Daemon`, which is
 * the composition `main` uses, rather than installing the port on the daemon itself.
 */
const theListenersHandTheWakePortToTheDaemon = {
  id: "the-listeners-hand-the-wake-port-to-the-daemon",
  what: "the production listener composition installs the CTO wake port on the daemon's report",
  file: "src/daemon/agentcpd.ts",
  find: "  daemon.setWakeTransportPeers?.(listeners.ctoConversation);\n",
  replace: "",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::names the build and says the binding cannot receive wakes, without naming a path",
  ],
};

export default theListenersHandTheWakePortToTheDaemon;
