const roleAttachmentDetachSlot = {
  "id": "role-attachment-detach-slot",
  "what": "attachment authorization: explicit detach clears the daemon slot",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    record?.detach?.();\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::explicit detach frees the slot and invalidates its credential"
  ]
};

export default roleAttachmentDetachSlot;
