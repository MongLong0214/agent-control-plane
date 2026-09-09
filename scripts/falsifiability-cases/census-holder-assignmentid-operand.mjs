const censusHolderAssignmentidOperand = {
  "id": "census-holder-assignmentid-operand",
  "what": "the current holder must match assignmentId independently",
  "file": "src/mcp/role-conversation.ts",
  "find": "current.assignmentId === binding.assignmentId",
  "replace": "true",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses the attached holder when only current assignmentId differs"
  ]
};

export default censusHolderAssignmentidOperand;
