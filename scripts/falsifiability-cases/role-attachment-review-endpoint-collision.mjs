const roleAttachmentReviewEndpointCollision = {
  id: "role-attachment-review-endpoint-collision",
  what: "attachment review: two current peers cannot share an endpoint",
  file: "src/mcp/role-conversation.ts",
  find: "      if (peer.server !== server && peer.endpoint === validated.value && this.currentHolderConnected(roleKey)) {",
  replace: "      if (false) {",
  killedBy: ["tests/unit/role-attachment-endpoints.test.ts::two current peers cannot share an endpoint and refusal names the competing role"],
};

export default roleAttachmentReviewEndpointCollision;
