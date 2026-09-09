const roleAttachmentSecretProof = {
  "id": "role-attachment-secret-proof",
  "what": "attachment authorization: authorization checks the attachment secret",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "!record || !timingSafeEqual(record.secretHash, hash(credential.attachmentSecret))",
  "replace": "!record",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::authorization rejects a wrong attachment secret"
  ]
};

export default roleAttachmentSecretProof;
