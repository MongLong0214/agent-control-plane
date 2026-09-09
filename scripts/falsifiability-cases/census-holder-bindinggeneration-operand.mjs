const censusHolderBindinggenerationOperand = {
  "id": "census-holder-bindinggeneration-operand",
  "what": "the current holder must match bindingGeneration independently",
  "file": "src/mcp/role-conversation.ts",
  "find": "current.bindingGeneration === binding.bindingGeneration",
  "replace": "true",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses the attached holder when only current bindingGeneration differs"
  ]
};

export default censusHolderBindinggenerationOperand;
