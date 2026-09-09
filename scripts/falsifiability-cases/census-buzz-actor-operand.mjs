const censusBuzzActorOperand = {
  "id": "census-buzz-actor-operand",
  "what": "Buzz actor is a string before authentication",
  "file": "src/daemon/agentcpd.ts",
  "find": "    typeof actor !== \"string\" ||\n    typeof conversation !== \"string\" ||\n",
  "replace": "    !((_value: unknown): _value is string => true)(actor) ||\n    typeof conversation !== \"string\" ||\n",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses a non-string Buzz actor before authentication"
  ]
};

export default censusBuzzActorOperand;
