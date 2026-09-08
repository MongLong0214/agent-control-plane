const roleAttachmentOwnerRejection = {
  "id": "role-attachment-owner-rejection",
  "what": "attachment authorization: an owner rejection is not attachment approval",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "approval.approved !== true || ",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an admitted rejection cannot issue a credential"
  ]
};

export default roleAttachmentOwnerRejection;
