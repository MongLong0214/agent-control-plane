const censusBuzzSignatureNullOperand = {
  "id": "census-buzz-signature-null-operand",
  "what": "Buzz signature null validation is independent",
  "file": "src/daemon/agentcpd.ts",
  "find": "    typeof text !== \"string\" ||\n    (signature !== undefined && signature !== null && typeof signature !== \"string\")",
  "replace": "    typeof text !== \"string\" ||\n    (signature !== undefined && true && typeof signature !== \"string\")",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::a Buzz null signature reaches authentication"
  ]
};

export default censusBuzzSignatureNullOperand;
