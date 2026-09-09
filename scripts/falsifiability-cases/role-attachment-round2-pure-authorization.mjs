const roleAttachmentRound2PureAuthorization = {
  "id": "role-attachment-round2-pure-authorization",
  "what": "attachment round 2: authorization reads cannot manufacture revocation",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "      return deny(ReasonCode.BINDING_GENERATION_STALE, \"attachment generation is no longer ACTIVE\");",
  "replace": "      this.#invalidate(attachmentId);\n      return deny(ReasonCode.BINDING_GENERATION_STALE, \"attachment generation is no longer ACTIVE\");",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::authorization rejects a noncurrent snapshot without repairing stored ownership"
  ]
};

export default roleAttachmentRound2PureAuthorization;
