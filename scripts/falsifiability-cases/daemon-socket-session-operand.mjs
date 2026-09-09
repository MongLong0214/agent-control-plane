const daemonSocketSessionOperand = {
  id: "daemon-socket-session-operand",
  what: "socket admission selects the authenticated session independently of incarnation",
  file: "src/daemon/agentcpd.ts",
  find: "      binding.sessionId === credential.sessionId &&\n",
  replace: "",
  killedBy: ["tests/unit/daemon-refusal-operands.test.ts::refuses a socket peer with another session ID even when its incarnation matches the holder"],
};

export default daemonSocketSessionOperand;
