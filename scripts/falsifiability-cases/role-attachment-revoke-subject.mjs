const roleAttachmentRevokeSubject = {
  "id": "role-attachment-revoke-subject",
  "what": "attachment authorization: revocation belongs to the authenticated subject",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "!record || record.scope.sessionId !== sessionId || record.scope.sessionIncarnation !== authenticated.value.incarnation",
  "replace": "!record",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::only the authenticated subject can revoke its attachment"
  ]
};

export default roleAttachmentRevokeSubject;
