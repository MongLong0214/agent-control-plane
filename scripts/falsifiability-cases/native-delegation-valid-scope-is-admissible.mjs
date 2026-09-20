// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const nativeDelegationValidScopeIsAdmissible = {
  "id": "native-delegation-valid-scope-is-admissible",
  "what": "the valid native delegation scope reaches owner admission",
  "file": "src/daemon/agentcpd.ts",
  "find": "!parsed.success || Date.parse(parsed.data.scope.expiresAt) <= cp.clock.now().getTime()",
  "replace": "!parsed.success || Date.parse(parsed.data.scope.expiresAt) > cp.clock.now().getTime()",
  "killedBy": [
    "tests/unit/native-owner-auth.test.ts::native"
  ]
};

export default nativeDelegationValidScopeIsAdmissible;
