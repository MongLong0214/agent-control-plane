const roleAttachmentEmptyAdmission = {
  "id": "role-attachment-empty-admission",
  "what": "attachment authorization: credential admission refuses an occupied slot",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "port.role !== Role.PRIMARY_CTO || port.currentHolderConnected(record.scope.roleKey)",
  "replace": "port.role !== Role.PRIMARY_CTO",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::connect refuses an occupied slot without consuming a pending credential"
  ]
};

export default roleAttachmentEmptyAdmission;
