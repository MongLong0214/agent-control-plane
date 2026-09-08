const roleAttachmentActiveGeneration = {
  "id": "role-attachment-active-generation",
  "what": "attachment authorization: authorization rechecks the ACTIVE registry generation",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "if (!current.allowed || digestOf(current.value) !== digestOf(record.scope))",
  "replace": "if (false)",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::authorization permanently invalidates a non-ACTIVE generation"
  ]
};

export default roleAttachmentActiveGeneration;
