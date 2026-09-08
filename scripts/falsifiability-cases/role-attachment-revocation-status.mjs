const roleAttachmentRevocationStatus = {
  id: "role-attachment-revocation-status",
  what: "a revoked scope is invalid even when its identity is unchanged",
  file: "src/session/role-attachment-credentials.ts",
  find: "binding.status === \"REVOKED\" || ",
  replace: "",
  killedBy: ["tests/unit/role-attachment-authorization.test.ts::committed revocations detach immediately"],
};

export default roleAttachmentRevocationStatus;
