const roleAttachmentRound2Reconnect = {
  "id": "role-attachment-round2-reconnect",
  "what": "attachment round 2: ordinary holder reconnect acquires its slot",
  "file": "src/mcp/role-conversation.ts",
  "find": "if (scopeRoleKey !== undefined && this.#live.has(binding.roleKey)) continue;",
  "replace": "if (this.#live.has(binding.roleKey)) continue;",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an ordinary reconnect acquires its holder slot before the incumbent closes"
  ]
};

export default roleAttachmentRound2Reconnect;
