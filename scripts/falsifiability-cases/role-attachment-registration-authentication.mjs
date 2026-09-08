const roleAttachmentRegistrationAuthentication = {
  id: "role-attachment-registration-authentication",
  what: "registration refuses a denied authenticator independently of binding currency",
  file: "src/mcp/role-conversation.ts",
  find: "\n      if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {",
  replace: "\n      if (!this.#isCurrentHolder(peer.binding, identity.value!)) {",
  killedBy: ["tests/unit/role-attachment-endpoints.test.ts::registration refuses a denied authenticator while the registry still names the peer as holder"],
};

export default roleAttachmentRegistrationAuthentication;
