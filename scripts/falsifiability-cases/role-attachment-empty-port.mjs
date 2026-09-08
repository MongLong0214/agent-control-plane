const roleAttachmentEmptyPort = {
  "id": "role-attachment-empty-port",
  "what": "attachment authorization: port attach preserves its incumbent",
  "file": "src/mcp/role-conversation.ts",
  "find": "      if (this.currentHolderConnected(binding.roleKey)) continue;\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::attach takes an empty slot and a later detach cannot evict its incumbent"
  ]
};

export default roleAttachmentEmptyPort;
