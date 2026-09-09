const roleAttachmentReviewTransportPool = {
  id: "role-attachment-review-transport-pool",
  what: "attachment review: a pooled initial copy cannot retain the credential slab",
  file: "src/daemon/agentcpd.ts",
  find: "    this.#buffer = Buffer.alloc(initial.length);\n    initial.copy(this.#buffer);",
  replace: "    this.#buffer = Buffer.from(initial);",
  killedBy: ["tests/unit/role-attachment-transport.test.ts::the transport detaches"],
};

export default roleAttachmentReviewTransportPool;
