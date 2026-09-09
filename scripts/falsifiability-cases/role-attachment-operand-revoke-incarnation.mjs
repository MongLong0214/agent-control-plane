const roleAttachmentOperandRevokeIncarnation = {
  id: "role-attachment-operand-revoke-incarnation",
  what: "attachment operands: revocation refuses a later incarnation of the same authenticated subject",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (!record || record.scope.sessionId !== sessionId || record.scope.sessionIncarnation !== authenticated.value.incarnation) {",
  replace: "    if (!record || record.scope.sessionId !== sessionId) {",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::revocation refuses a later incarnation of the same authenticated subject"],
};

export default roleAttachmentOperandRevokeIncarnation;
