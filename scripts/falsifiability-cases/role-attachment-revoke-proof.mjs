const roleAttachmentRevokeProof = {
  "id": "role-attachment-revoke-proof",
  "what": "attachment authorization: revocation requires the subject session secret",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    const { sessionId, sessionSecret, attachmentId } = parsed.data;\n    const authenticated = this.sessions.verifySecret(sessionId, sessionSecret);",
  "replace": "    const { sessionId, sessionSecret, attachmentId } = parsed.data;\n    const authenticated = allow(ReasonCode.OK, this.sessions.require(sessionId));",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::only the authenticated subject can revoke its attachment"
  ]
};

export default roleAttachmentRevokeProof;
