const roleAttachmentRound2AdmissionPreservesCurrent = {
  "id": "role-attachment-round2-admission-preserves-current",
  "what": "attachment round 2: admission repair preserves a current scoped incumbent",
  "file": "src/mcp/role-conversation.ts",
  "find": "if (!this.currentHolderConnected(roleKey)) this.#live.delete(roleKey);",
  "replace": "this.#live.delete(roleKey);",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::attach takes an empty slot and a later detach cannot evict its incumbent"
  ]
};

export default roleAttachmentRound2AdmissionPreservesCurrent;
