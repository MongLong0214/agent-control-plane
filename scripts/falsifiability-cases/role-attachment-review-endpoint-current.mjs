const roleAttachmentReviewEndpointCurrent = {
  id: "role-attachment-review-endpoint-current",
  what: "attachment review: stale competitors cannot reserve an endpoint",
  file: "src/mcp/role-conversation.ts",
  find: "      if (peer.server !== server && peer.endpoint === validated.value && this.currentHolderConnected(roleKey)) {",
  replace: "      if (peer.server !== server && peer.endpoint === validated.value) {",
  killedBy: ["tests/unit/role-attachment-endpoints.test.ts::a stale competitor cannot block a current endpoint registration"],
};

export default roleAttachmentReviewEndpointCurrent;
