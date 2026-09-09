// Revocation can leave a peer registered in the same generation; presence alone would reserve its slot.
const roleAttachmentSuccessorCredential = {
  "id": "role-attachment-successor-credential",
  "what": "attachment authorization: credential admission revalidates slot occupancy",
  "file": "src/mcp/role-conversation.ts",
  "find": "return peer !== undefined && this.#holderFor(peer.server, roleKey).allowed;",
  "replace": "return peer !== undefined;",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::a same-generation successor acquires the slot via credential"
  ]
};

export default roleAttachmentSuccessorCredential;
