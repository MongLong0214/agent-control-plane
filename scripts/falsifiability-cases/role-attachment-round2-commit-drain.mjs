const roleAttachmentRound2CommitDrain = {
  "id": "role-attachment-round2-commit-drain",
  "what": "attachment round 2: committed notifications are drained once",
  "file": "src/db/database.ts",
  "find": "    const committed = this.#afterCommit;\n    this.#afterCommit = [];",
  "replace": "    const committed = this.#afterCommit;",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::a fresh attachment after a round trip survives later commits"
  ]
};

export default roleAttachmentRound2CommitDrain;
