const roleAttachmentSibling = {
  "id": "role-attachment-sibling",
  "what": "attachment authorization: an attachment cannot acquire sibling role slots",
  "file": "src/mcp/role-conversation.ts",
  "find": "      if (scopeRoleKey !== undefined && binding.roleKey !== scopeRoleKey) continue;\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an attachment never auto-authorizes a sibling role held by the same subject"
  ]
};

export default roleAttachmentSibling;
