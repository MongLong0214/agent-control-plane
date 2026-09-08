const roleAttachmentSocketRegistrationCurrent = {
  "id": "role-attachment-socket-registration-current",
  "what": "attachment sockets: registration refuses authority lost on an open connection",
  "file": "src/mcp/role-conversation.ts",
  "find": "    for (const [roleKey, peer] of owned) {\n      const identity = peer.authenticate();\n      if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {\n        if (this.#live.get(roleKey) === peer) this.#live.delete(roleKey);\n        return deny(ReasonCode.ROLE_PEER_STALE, \"the registering peer no longer holds its role\");\n      }\n    }\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-sockets.test.ts::registration revalidation refuses a changed generation on an already open attachment"
  ]
};

export default roleAttachmentSocketRegistrationCurrent;
