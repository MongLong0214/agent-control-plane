const roleAttachmentOwnerScope = {
  "id": "role-attachment-owner-scope",
  "what": "attachment authorization: approval binds the registry generation and subject",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "approval.parameterDigest !== digestOf(scope.value)",
  "replace": "false",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::approval cannot follow a holder into a new registry generation"
  ]
};

export default roleAttachmentOwnerScope;
