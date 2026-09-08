const roleAttachmentBindNotification = {
  id: "role-attachment-bind-notification",
  what: "a committed bind publishes its successor",
  file: "src/session/binding-registry.ts",
  find: "      this.#notifySwitch(created);\n",
  replace: "",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::binding a revoked key publishes its committed successor"],
};

export default roleAttachmentBindNotification;
