const roleAttachmentSingleConnection = {
  "id": "role-attachment-single-connection",
  "what": "attachment authorization: one credential admits one connection",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "    if (record.attached) return refused(\"attachment credential has already admitted a connection\");\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::one credential cannot admit two simultaneous connections even to another port"
  ]
};

export default roleAttachmentSingleConnection;
