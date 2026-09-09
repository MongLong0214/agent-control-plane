const roleAttachmentReviewEndpointLookup = {
  id: "role-attachment-review-endpoint-lookup",
  what: "attachment review: endpoint lookup excludes former holders",
  file: "src/mcp/role-conversation.ts",
  find: "    if (!this.currentHolderConnected(roleKey)) return null;\n",
  replace: "",
  killedBy: ["tests/unit/role-attachment-endpoints.test.ts::endpoint lookup does not expose a former holder registration"],
};

export default roleAttachmentReviewEndpointLookup;
