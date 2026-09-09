const roleAttachmentRound2CommitBoundary = {
  "id": "role-attachment-round2-commit-boundary",
  "what": "attachment round 2: transfer publication waits for the outer commit",
  "file": "src/db/database.ts",
  "find": "if (this.#depth > 0) this.#afterCommit.push(notify);",
  "replace": "if (false) this.#afterCommit.push(notify);",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::committed transfers detach immediately and rolled-back transfers preserve attachments"
  ]
};

export default roleAttachmentRound2CommitBoundary;
