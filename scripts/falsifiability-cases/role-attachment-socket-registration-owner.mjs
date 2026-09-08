const roleAttachmentSocketRegistrationOwner = {
  "id": "role-attachment-socket-registration-owner",
  "what": "attachment sockets: endpoint registration uses the receiving server identity",
  "file": "src/mcp/role-conversation.ts",
  "find": "const owned = [...this.#live.entries()].filter(([, peer]) => peer.server === server);",
  "replace": "const owned = [...this.#live.entries()];",
  "killedBy": [
    "tests/unit/role-attachment-sockets.test.ts::an ordinary holder reconnect takes over an attachment and the former connection cannot register"
  ]
};

export default roleAttachmentSocketRegistrationOwner;
