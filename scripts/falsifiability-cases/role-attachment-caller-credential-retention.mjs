// Retain the caller object while still authenticating from the admitted record.
const roleAttachmentCallerCredentialRetention = {
  id: "role-attachment-caller-credential-retention",
  what: "attachment authorization: the live authenticator permits caller credential collection",
  file: "src/session/role-attachment-credentials.ts",
  find: "() => this.#authorizeRecord(attachmentId, record)",
  replace: "() => { Object.keys(credential); return this.#authorizeRecord(attachmentId, record); }",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::an admitted connection authenticates without retaining the caller credential",
  ],
};

export default roleAttachmentCallerCredentialRetention;
