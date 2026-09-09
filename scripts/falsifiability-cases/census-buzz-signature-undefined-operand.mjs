const censusBuzzSignatureUndefinedOperand = {
  "id": "census-buzz-signature-undefined-operand",
  "what": "Buzz signature undefined validation is independent",
  "file": "src/daemon/agentcpd.ts",
  "find": "    typeof text !== \"string\" ||\n    (signature !== undefined && signature !== null && typeof signature !== \"string\")",
  "replace": "    typeof text !== \"string\" ||\n    (true && signature !== null && typeof signature !== \"string\")",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::a Buzz undefined signature reaches authentication"
  ]
};

export default censusBuzzSignatureUndefinedOperand;
