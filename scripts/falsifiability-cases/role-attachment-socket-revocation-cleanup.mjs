const roleAttachmentSocketRevocationCleanup = {
  id: "role-attachment-socket-revocation-cleanup",
  what: "attachment sockets: revocation clears the slot before endpoint revalidation",
  file: "src/session/role-attachment-credentials.ts",
  find: "    record?.detach?.();\n",
  replace: "",
  killedBy: [
    "tests/unit/role-attachment-sockets.test.ts::revocation clears registration on an open connection without revoking the session credential",
  ],
};

export default roleAttachmentSocketRevocationCleanup;
