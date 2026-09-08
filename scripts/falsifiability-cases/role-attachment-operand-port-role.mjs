const roleAttachmentOperandPortRole = {
  id: "role-attachment-operand-port-role",
  what: "attachment operands: connect refuses an empty non-primary port before attempting admission",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (port.role !== Role.PRIMARY_CTO || port.currentHolderConnected(record.scope.roleKey)) {",
  replace: "    if (port.currentHolderConnected(record.scope.roleKey)) {",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::connect refuses an empty non-primary port before attempting admission"],
};

export default roleAttachmentOperandPortRole;
