const roleAttachmentRound2PureStaleHolder = {
  "id": "role-attachment-round2-pure-stale-holder",
  "what": "attachment round 2: stale holder lookup cannot repair ownership",
  "file": "src/mcp/role-conversation.ts",
  "find": "    const identity = peer.authenticate();\n    if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {\n      return deny(\n        ReasonCode.ROLE_PEER_STALE,\n        \"the attached peer no longer holds the role its socket was admitted under\",\n        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },\n      );\n    }\n    // From the registry",
  "replace": "    const identity = peer.authenticate();\n    if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {\n      this.#live.delete(roleKey);\n      return deny(\n        ReasonCode.ROLE_PEER_STALE,\n        \"the attached peer no longer holds the role its socket was admitted under\",\n        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },\n      );\n    }\n    // From the registry",
  "killedBy": [
    "tests/unit/role-attachment-endpoints.test.ts::endpoint lookup does not expose a former holder registration"
  ]
};

export default roleAttachmentRound2PureStaleHolder;
