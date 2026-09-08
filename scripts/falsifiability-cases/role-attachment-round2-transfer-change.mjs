const roleAttachmentRound2TransferChange = {
  "id": "role-attachment-round2-transfer-change",
  "what": "attachment round 2: an unchanged holder keeps its approval",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "record.scope.roleKey === binding.roleKey && digestOf(record.scope) !== digestOf(current)",
  "replace": "record.scope.roleKey === binding.roleKey",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an unchanged holder and a sibling transfer preserve the approved attachment"
  ]
};

export default roleAttachmentRound2TransferChange;
