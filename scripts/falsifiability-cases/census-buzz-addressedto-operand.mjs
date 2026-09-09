const censusBuzzAddressedtoOperand = {
  "id": "census-buzz-addressedto-operand",
  "what": "Buzz addressedTo is a string before authentication",
  "file": "src/daemon/agentcpd.ts",
  "find": "    typeof addressedTo !== \"string\" ||\n",
  "replace": "    !((_value: unknown): _value is string => true)(addressedTo) ||\n",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses a non-string Buzz addressedTo before authentication"
  ]
};

export default censusBuzzAddressedtoOperand;
