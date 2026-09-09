const daemonMessageTextOperand = {
  id: "daemon-message-text-operand",
  what: "Buzz messages require string text before sender authentication",
  file: "src/daemon/agentcpd.ts",
  find: "    typeof text !== \"string\" ||\n",
  // Keep the type narrowing while admitting every value, so the mutant still compiles.
  replace: "    !((_value: unknown): _value is string => true)(text) ||\n",
  killedBy: ["tests/unit/daemon-refusal-operands.test.ts::refuses a non-string Buzz message body before authentication"],
};

export default daemonMessageTextOperand;
