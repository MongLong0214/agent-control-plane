const roleAttachmentFirstUseBoundary = {
  id: "role-attachment-first-use-boundary",
  what: "attachment authorization refuses first use at the deadline, not just after it",
  file: "src/session/role-attachment-credentials.ts",
  find: "    if (!record.attached && this.clock.nowIso() >= record.firstUseExpiresAt) {",
  replace: "    if (!record.attached && this.clock.nowIso() > record.firstUseExpiresAt) {",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::first-use window refuses a credential at the exact deadline",
  ],
};

export default roleAttachmentFirstUseBoundary;
