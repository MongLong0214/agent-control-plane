const roleAttachmentOperandScopeIncarnation = {
  id: "role-attachment-operand-scope-incarnation",
  what: "attachment operands: scope refuses a stale incarnation of the same primary subject",
  file: "src/session/role-attachment-credentials.ts",
  find: "        !session || binding.sessionIncarnation !== session.incarnation ||",
  replace: "        !session ||",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::scope refuses a stale incarnation of the same primary subject"],
};

export default roleAttachmentOperandScopeIncarnation;
