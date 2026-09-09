const roleAttachmentOperandScopeSubject = {
  id: "role-attachment-operand-scope-subject",
  what: "attachment operands: scope refuses a different subject even when incarnations are equal",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (!binding || binding.role !== Role.PRIMARY_CTO || binding.sessionId !== sessionId ||",
  replace: "    if (!binding || binding.role !== Role.PRIMARY_CTO ||",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::scope refuses a different subject even when incarnations are equal"],
};

export default roleAttachmentOperandScopeSubject;
