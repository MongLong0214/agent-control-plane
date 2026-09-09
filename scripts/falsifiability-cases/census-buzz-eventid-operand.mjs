const censusBuzzEventidOperand = {
  "id": "census-buzz-eventid-operand",
  "what": "Buzz eventId is a string before authentication",
  "file": "src/daemon/agentcpd.ts",
  "find": "    typeof eventId !== \"string\" ||\n",
  "replace": "    !((_value: unknown): _value is string => true)(eventId) ||\n",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses a non-string Buzz eventId before authentication"
  ]
};

export default censusBuzzEventidOperand;
