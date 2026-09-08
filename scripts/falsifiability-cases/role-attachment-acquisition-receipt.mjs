// A stale registration is not proof that the scoped attachment acquired a current slot.
const roleAttachmentAcquisitionReceipt = {
  "id": "role-attachment-acquisition-receipt",
  "what": "attachment authorization: the acquisition receipt checks current holder occupancy",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "if (!port.currentHolderConnected(record.scope.roleKey)) return refused(\"attachment did not acquire its role slot\");",
  "replace": "if (!port.connected(record.scope.roleKey)) return refused(\"attachment did not acquire its role slot\");",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::connect refuses stale registration without consuming a pending credential"
  ]
};

export default roleAttachmentAcquisitionReceipt;
