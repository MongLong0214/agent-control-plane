const roleAttachmentNoReplay = {
  "id": "role-attachment-no-replay",
  "what": "attachment authorization: operator retries cannot re-serve credential plaintext",
  "file": "src/daemon/daemon.ts",
  find: "    const key = request.method !== OPERATOR_METHOD.ROLE_ATTACHMENT_ISSUE &&",
  replace: "    const key = true &&",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::operator retries never re-serve a plaintext attachment credential"
  ]
};

export default roleAttachmentNoReplay;
