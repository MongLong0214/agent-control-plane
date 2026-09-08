// A stale registration must not block a successor while the former server awaits detach.
const roleAttachmentSuccessorPort = {
  "id": "role-attachment-successor-port",
  "what": "attachment authorization: port admission revalidates the incumbent",
  "file": "src/mcp/role-conversation.ts",
  "find": "      this.#clearStalePeer(binding.roleKey);\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::a same-generation successor acquires the slot via port"
  ]
};

export default roleAttachmentSuccessorPort;
