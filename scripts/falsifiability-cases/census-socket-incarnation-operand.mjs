const censusSocketIncarnationOperand = {
  "id": "census-socket-incarnation-operand",
  "what": "socket admission compares incarnation independently of session ID",
  "file": "src/daemon/agentcpd.ts",
  "find": "      binding.sessionIncarnation === session.value.incarnation,",
  "replace": "      true,",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses the holder session when only its socket binding incarnation differs"
  ]
};

export default censusSocketIncarnationOperand;
