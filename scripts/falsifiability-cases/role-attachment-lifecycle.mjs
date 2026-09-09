const roleAttachmentLifecycle = {
  "id": "role-attachment-lifecycle",
  "what": "attachment authorization: a stopped subject cannot retain attachment authority",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "(session.lifecycle !== SessionLifecycle.READY && session.lifecycle !== SessionLifecycle.DRAINING)",
  "replace": "false",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::a stopped subject loses attachment authorization"
  ]
};

export default roleAttachmentLifecycle;
