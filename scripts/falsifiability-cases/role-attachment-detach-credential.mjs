const roleAttachmentDetachCredential = {
  "id": "role-attachment-detach-credential",
  "what": "attachment authorization: explicit detach permanently invalidates its credential",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    this.#records.delete(attachmentId);\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::explicit detach frees the slot and invalidates its credential"
  ]
};

export default roleAttachmentDetachCredential;
