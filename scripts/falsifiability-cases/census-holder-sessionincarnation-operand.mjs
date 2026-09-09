const censusHolderSessionincarnationOperand = {
  "id": "census-holder-sessionincarnation-operand",
  "what": "the current holder must match sessionIncarnation independently",
  "file": "src/mcp/role-conversation.ts",
  "find": "current.sessionIncarnation === peer.sessionIncarnation",
  "replace": "true",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses the attached holder when only current sessionIncarnation differs"
  ]
};

export default censusHolderSessionincarnationOperand;
