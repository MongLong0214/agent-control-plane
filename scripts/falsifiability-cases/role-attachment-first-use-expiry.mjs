const roleAttachmentFirstUseExpiry = {
  id: "role-attachment-first-use-expiry",
  what: "attachment authorization refuses an unused credential past its first-use deadline",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (!record.attached && this.clock.nowIso() >= record.firstUseExpiresAt) {",
  replace: "    if (false) {",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::first-use window refuses an unattached credential after 60 seconds",
  ],
};

export default roleAttachmentFirstUseExpiry;
