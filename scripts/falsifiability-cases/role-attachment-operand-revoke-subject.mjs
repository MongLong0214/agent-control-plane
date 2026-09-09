const roleAttachmentOperandRevokeSubject = {
  id: "role-attachment-operand-revoke-subject",
  what: "attachment operands: revocation refuses a different subject even when incarnations are equal",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (!record || record.scope.sessionId !== sessionId || record.scope.sessionIncarnation !== authenticated.value.incarnation) {",
  replace: "    if (!record || record.scope.sessionIncarnation !== authenticated.value.incarnation) {",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::revocation refuses a different subject even when incarnations are equal"],
};

export default roleAttachmentOperandRevokeSubject;
