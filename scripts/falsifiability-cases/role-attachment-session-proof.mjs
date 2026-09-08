const roleAttachmentSessionProof = {
  "id": "role-attachment-session-proof",
  "what": "attachment authorization: issuance requires the existing session secret",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    if (!authenticated.allowed) return authenticated;\n    const scope =",
  "replace": "    const scope =",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::issuance rejects a wrong session secret without spending the approval"
  ]
};

export default roleAttachmentSessionProof;
