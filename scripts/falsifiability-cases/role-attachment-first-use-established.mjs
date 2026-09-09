const roleAttachmentFirstUseEstablished = {
  id: "role-attachment-first-use-established",
  what: "the first-use deadline does not expire an established attachment",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (!record.attached && this.clock.nowIso() >= record.firstUseExpiresAt) {",
  replace: "    if (this.clock.nowIso() >= record.firstUseExpiresAt) {",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::first-use window does not expire an established attachment",
  ],
};

export default roleAttachmentFirstUseEstablished;
