const roleAttachmentOwnerAdmission = {
  "id": "role-attachment-owner-admission",
  "what": "attachment authorization: a forged owner receipt cannot authorize issuance",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    if (!consumed.allowed) return consumed;\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::missing and forged decisions cannot authorize issuance"
  ]
};

export default roleAttachmentOwnerAdmission;
