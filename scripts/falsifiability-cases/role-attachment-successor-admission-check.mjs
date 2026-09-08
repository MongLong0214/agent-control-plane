// connected() only observes registration; a revoked incumbent can still have an entry here.
const roleAttachmentSuccessorAdmissionCheck = {
  "id": "role-attachment-successor-admission-check",
  "what": "attachment authorization: the credential door checks current holder occupancy",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "port.currentHolderConnected(record.scope.roleKey)",
  "replace": "port.connected(record.scope.roleKey)",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::a same-generation successor acquires the slot via credential"
  ]
};

export default roleAttachmentSuccessorAdmissionCheck;
