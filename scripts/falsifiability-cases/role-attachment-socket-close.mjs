const roleAttachmentSocketClose = {
  "id": "role-attachment-socket-close",
  "what": "attachment sockets: connection close invalidates the slot and credential",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    const close = () => this.#invalidate(attachmentId);",
  "replace": "    const close = () => {};",
  "killedBy": [
    "tests/unit/role-attachment-sockets.test.ts::connection close after MCP initialization clears registration and permanently spends the credential"
  ]
};

export default roleAttachmentSocketClose;
