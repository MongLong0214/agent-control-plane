const roleAttachmentReviewTransportReceive = {
  id: "role-attachment-review-transport-receive",
  what: "attachment review: later frames do not regain a credential-bearing slab",
  file: "src/daemon/agentcpd.ts",
  find: "    const next = Buffer.alloc(this.#buffer.length + chunk.length);\n    this.#buffer.copy(next);\n    chunk.copy(next, this.#buffer.length);\n    this.#buffer = next;",
  replace: "    this.#buffer = Buffer.concat([this.#buffer, chunk]);",
  killedBy: ["tests/unit/role-attachment-transport.test.ts::the transport detaches"],
};

export default roleAttachmentReviewTransportReceive;
