const roleAttachmentOperandScopeRole = {
  id: "role-attachment-operand-scope-role",
  what: "attachment operands: scope refuses a non-primary binding before any port can filter its role",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (!binding || binding.role !== Role.PRIMARY_CTO || binding.sessionId !== sessionId ||",
  replace: "    if (!binding || binding.sessionId !== sessionId ||",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::scope refuses a non-primary binding before any port can filter its role"],
};

export default roleAttachmentOperandScopeRole;
