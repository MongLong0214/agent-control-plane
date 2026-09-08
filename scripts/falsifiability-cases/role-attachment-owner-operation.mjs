const roleAttachmentOwnerOperation = {
  "id": "role-attachment-owner-operation",
  "what": "attachment authorization: approval names the attachment operation",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "approval.operation !== ROLE_ATTACHMENT_OPERATION ||",
  "replace": "false ||",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::approval for another operation cannot issue a credential"
  ]
};

export default roleAttachmentOwnerOperation;
