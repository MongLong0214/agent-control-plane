const roleAttachmentRound2PureRegistration = {
  "id": "role-attachment-round2-pure-registration",
  "what": "attachment round 2: registration refusal does not repair stale ownership",
  "file": "src/mcp/role-conversation.ts",
  "find": "        return deny(ReasonCode.ROLE_PEER_STALE, \"the registering peer no longer holds its role\");",
  "replace": "        this.#live.delete(peer.binding.roleKey);\n        return deny(ReasonCode.ROLE_PEER_STALE, \"the registering peer no longer holds its role\");",
  "killedBy": [
    "tests/unit/role-attachment-endpoints.test.ts::stale registration and wake refuse without repairing stored ownership"
  ]
};

export default roleAttachmentRound2PureRegistration;
