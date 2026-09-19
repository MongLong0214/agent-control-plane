// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "native-delegation-composed-port-is-usable",
  "what": "the composed native delegation port accepts valid parameters",
  "file": "src/daemon/agentcpd.ts",
  "find": "!params || !options.approveCtoDelegate",
  "replace": "(!params || !options.approveCtoDelegate) || true",
  "killedBy": [
    "tests/unit/native-owner-auth.test.ts::native"
  ]
};
