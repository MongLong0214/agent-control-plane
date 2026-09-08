const roleAttachmentRound2TransferRole = {
  "id": "role-attachment-round2-transfer-role",
  "what": "attachment round 2: transfer revokes only credentials for its role",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "record.scope.roleKey === binding.roleKey &&\n            (binding.status === \"REVOKED\" || digestOf(record.scope) !== digestOf(current))",
  "replace": "(binding.status === \"REVOKED\" || digestOf(record.scope) !== digestOf(current))",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an unchanged holder and a sibling transfer preserve the approved attachment"
  ]
};

export default roleAttachmentRound2TransferRole;
