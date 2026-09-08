const roleAttachmentSocketRegistrationCurrent = {
  "id": "role-attachment-socket-registration-current",
  "what": "attachment sockets: registration refuses authority lost on an open connection",
  "file": "src/mcp/role-conversation.ts",
  "find": "    for (const [, peer] of owned) {\n      const identity = peer.authenticate();\n      if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {\n        return deny(ReasonCode.ROLE_PEER_STALE, \"the registering peer no longer holds its role\");\n      }\n    }\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-endpoints.test.ts::stale registration and wake refuse without repairing stored ownership"
  ]
};

export default roleAttachmentSocketRegistrationCurrent;
