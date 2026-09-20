// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationVacantRoleCanBind = {
  "id": "delegation-vacant-role-can-bind",
  "what": "a vacant role is not refused as a live incumbent",
  "file": "src/daemon/cto-delegated-binding.ts",
  "find": "      if (current && !dead(current)",
  "replace": "      if (!current || !dead(current)",
  "killedBy": [
    "tests/unit/cto-delegated-binding.test.ts::socket authenticates CEO"
  ]
};

export default delegationVacantRoleCanBind;
