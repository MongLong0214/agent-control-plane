const roleAttachmentRound2PureWake = {
  "id": "role-attachment-round2-pure-wake",
  "what": "attachment round 2: wake refusal does not repair stale ownership",
  "file": "src/mcp/role-conversation.ts",
  "find": "    const identity = peer.authenticate();\n    if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {\n      return deny(\n        ReasonCode.ROLE_PEER_STALE,\n        \"the attached peer no longer holds the role its socket was admitted under\",\n        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },\n      );\n    }\n    if (peer.endpoint === null) {",
  "replace": "    const identity = peer.authenticate();\n    if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {\n      this.#live.delete(roleKey);\n      return deny(\n        ReasonCode.ROLE_PEER_STALE,\n        \"the attached peer no longer holds the role its socket was admitted under\",\n        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },\n      );\n    }\n    if (peer.endpoint === null) {",
  "killedBy": [
    "tests/unit/role-attachment-endpoints.test.ts::stale registration and wake refuse without repairing stored ownership"
  ]
};

export default roleAttachmentRound2PureWake;
