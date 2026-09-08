const roleAttachmentRevocationNotification = {
  id: "role-attachment-revocation-notification",
  what: "a committed revocation detaches and reaps attachments",
  file: "src/session/binding-registry.ts",
  find: "      this.#notifySwitch({ ...current, status: \"REVOKED\" });\n",
  replace: "",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::committed revocations detach immediately"],
};

export default roleAttachmentRevocationNotification;
