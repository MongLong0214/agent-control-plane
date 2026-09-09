const censusBuzzConversationOperand = {
  "id": "census-buzz-conversation-operand",
  "what": "Buzz conversation is a string before authentication",
  "file": "src/daemon/agentcpd.ts",
  "find": "    typeof conversation !== \"string\" ||\n",
  "replace": "    !((_value: unknown): _value is string => true)(conversation) ||\n",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses a non-string Buzz conversation before authentication"
  ]
};

export default censusBuzzConversationOperand;
