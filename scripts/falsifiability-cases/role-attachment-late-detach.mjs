export default {
  "id": "role-attachment-late-detach",
  "what": "attachment authorization: a former receiving server cannot detach its successor",
  "file": "src/mcp/role-conversation.ts",
  "find": "if (this.#live.get(roleKey)?.server === server) this.#live.delete(roleKey);",
  "replace": "this.#live.delete(roleKey);",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::late detach of a former server preserves its successor"
  ]
};
