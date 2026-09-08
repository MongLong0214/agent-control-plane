// The callback outlives the handshake; capturing the bearer would keep its plaintext alive too.
const roleAttachmentPlaintextRetention = {
  "id": "role-attachment-plaintext-retention",
  "what": "attachment authorization: the admitted authenticator does not retain caller credential plaintext",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "() => this.#authorizeRecord(attachmentId, record)",
  "replace": "() => this.authorize(credential)",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an admitted connection authenticates without retaining the caller credential"
  ]
};

export default roleAttachmentPlaintextRetention;
