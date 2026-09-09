const censusHolderRoleOperand = {
  "id": "census-holder-role-operand",
  "what": "the current holder must match role independently",
  "file": "src/mcp/role-conversation.ts",
  "find": "current.role === this.#role",
  "replace": "true",
  "killedBy": [
    "tests/unit/daemon-refusal-operands.test.ts::refuses the attached holder when only current role differs"
  ]
};

export default censusHolderRoleOperand;
