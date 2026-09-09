const roleAttachmentPresentedScope = {
  "id": "role-attachment-presented-scope",
  "what": "attachment authorization: client declarations cannot rewrite credential scope",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    if (digestOf(presentedScope) !== digestOf(record.scope)) return refused(\"attachment scope does not match issuance\");\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::client declared identity and generation cannot change attachment scope"
  ]
};

export default roleAttachmentPresentedScope;
