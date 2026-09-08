const roleAttachmentRound2TransferSnapshot = {
  "id": "role-attachment-round2-transfer-snapshot",
  "what": "attachment round 2: notification retains the committed transfer snapshot",
  "file": "src/session/binding-registry.ts",
  "find": "const transferred = { ...binding };",
  "replace": "const transferred = binding;",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::transfer notification retains its identity when the returned binding is edited"
  ]
};

export default roleAttachmentRound2TransferSnapshot;
