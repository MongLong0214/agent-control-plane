const roleAttachmentHolderSessionOperand = {
  id: "role-attachment-holder-session-operand",
  what: "endpoint currency checks the session independently of incarnation",
  file: "src/mcp/role-conversation.ts",
  find: "      current.sessionId === peer.sessionId &&\n",
  replace: "",
  killedBy: ["tests/unit/role-attachment-endpoints.test.ts::a different session with the same incarnation cannot retain the holder endpoint"],
};

export default roleAttachmentHolderSessionOperand;
