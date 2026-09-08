const roleAttachmentNoReplay = {
  "id": "role-attachment-no-replay",
  "what": "attachment authorization: operator retries cannot re-serve credential plaintext",
  "file": "src/daemon/daemon.ts",
  "find": "request.method !== OPERATOR_METHOD.ROLE_ATTACHMENT_ISSUE &&\n      ",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::operator retries never re-serve a plaintext attachment credential"
  ]
};

export default roleAttachmentNoReplay;
