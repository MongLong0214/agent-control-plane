// The other half of the same condition. Without the deadline comparison the sweep reaps every
// unattached record on every issuance, so a caller who asks for a second credential silently
// destroys the first one it is still holding and has not yet used -- an invalidation with no
// expiry behind it, reported to the holder as "unknown or invalid".
const roleAttachmentSweepSparesOpenWindow = {
  id: "role-attachment-sweep-spares-open-window",
  what: "the issuance sweep reaps only credentials whose first-use window has closed",
  file: "src/session/role-attachment-credentials.ts",
  find: "      if (!record.attached && now >= record.firstUseExpiresAt) this.#invalidate(id);",
  replace: "      if (!record.attached) this.#invalidate(id);",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::a later issuance spares an unattached credential still inside its window",
  ],
};

export default roleAttachmentSweepSparesOpenWindow;
