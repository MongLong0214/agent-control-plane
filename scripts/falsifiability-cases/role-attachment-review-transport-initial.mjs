const roleAttachmentReviewTransportInitial = {
  id: "role-attachment-review-transport-initial",
  what: "attachment review: transport detaches the handshake backing allocation",
  file: "src/daemon/agentcpd.ts",
  find: "    this.#buffer = Buffer.alloc(initial.length);\n    initial.copy(this.#buffer);",
  replace: "    this.#buffer = initial;",
  killedBy: ["tests/unit/role-attachment-transport.test.ts::the transport detaches"],
};

export default roleAttachmentReviewTransportInitial;
