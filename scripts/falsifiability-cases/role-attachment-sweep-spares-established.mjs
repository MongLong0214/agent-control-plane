// The issuance sweep exists because issuance is now repeatable: nothing else reaps an unattached
// record whose window closed, since `#authorizeRecord` only notices expiry when that exact
// credential is presented again. Dropping the `!record.attached` half turns the reaper on live
// connections -- every issuance would detach whoever is holding the role slot.
const roleAttachmentSweepSparesEstablished = {
  id: "role-attachment-sweep-spares-established",
  what: "the issuance sweep reaps only unattached credentials, never an established attachment",
  file: "src/session/role-attachment-credentials.ts",
  find: "      if (!record.attached && now >= record.firstUseExpiresAt) this.#invalidate(id);",
  replace: "      if (now >= record.firstUseExpiresAt) this.#invalidate(id);",
  killedBy: [
    "tests/unit/role-attachment-authorization.test.ts::an established attachment survives a later issuance's sweep",
  ],
};

export default roleAttachmentSweepSparesEstablished;
