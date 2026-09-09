const censusBuzzSignatureTypeOperand = {
  "id": "census-buzz-signature-type-operand",
  "what": "Buzz signature type validation is independent",
  "file": "src/daemon/agentcpd.ts",
  "find": "    typeof text !== \"string\" ||\n    (signature !== undefined && signature !== null && typeof signature !== \"string\")",
  "replace": "    typeof text !== \"string\" ||\n    (signature !== undefined && signature !== null && !((_value: unknown): _value is string => true)(signature))",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses a non-string Buzz signature before authentication"
  ]
};

export default censusBuzzSignatureTypeOperand;
