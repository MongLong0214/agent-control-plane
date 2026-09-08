const daemonMessageTextOperand = {
  id: "daemon-message-text-operand",
  what: "Buzz messages require string text before sender authentication",
  file: "src/daemon/agentcpd.ts",
  find: "    typeof text !== \"string\" ||\n",
  replace: "",
  killedBy: ["tests/unit/daemon-refusal-operands.test.ts::refuses a non-string Buzz message body before authentication"],
};

export default daemonMessageTextOperand;
