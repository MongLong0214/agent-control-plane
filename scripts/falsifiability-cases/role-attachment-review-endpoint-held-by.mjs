const roleAttachmentReviewEndpointHeldBy = {
  id: "role-attachment-review-endpoint-held-by",
  what: "attachment review: collision refusal names the competing role key",
  file: "src/mcp/role-conversation.ts",
  find: "          { role: this.#role, heldBy: roleKey },",
  replace: "          { role: this.#role, heldBy: owned[0]![0] },",
  killedBy: ["tests/unit/role-attachment-endpoints.test.ts::two current peers cannot share an endpoint and refusal names the competing role"],
};

export default roleAttachmentReviewEndpointHeldBy;
