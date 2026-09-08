export default {
  "id": "role-attachment-retained-record",
  "what": "attachment authorization: a retained authenticator refuses its invalidated record",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    if (this.#records.get(attachmentId) !== record) return refused(\"attachment has been invalidated\");\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an admitted connection authenticates without retaining the caller credential"
  ]
};
