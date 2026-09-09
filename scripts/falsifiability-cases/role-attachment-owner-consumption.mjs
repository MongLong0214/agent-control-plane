const roleAttachmentOwnerConsumption = {
  "id": "role-attachment-owner-consumption",
  "what": "attachment authorization: an owner approval is consumed once",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "this.owner.consumeApproval(approval, null)",
  "replace": "this.owner.assertApproval(approval)",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::one admitted approval issues only one credential"
  ]
};

export default roleAttachmentOwnerConsumption;
