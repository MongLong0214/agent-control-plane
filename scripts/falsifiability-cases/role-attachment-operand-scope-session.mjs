const roleAttachmentOperandScopeSession = {
  id: "role-attachment-operand-scope-session",
  what: "attachment operands: scope returns a typed refusal when the binding outlives its session lookup",
  file: "src/session/role-attachment-credentials.ts",
  find: "        !session || binding.sessionIncarnation !== session.incarnation ||",
  replace: "        binding.sessionIncarnation !== session.incarnation ||",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::scope returns a typed refusal when the binding outlives its session lookup"],
};

export default roleAttachmentOperandScopeSession;
