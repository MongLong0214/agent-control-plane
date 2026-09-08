const roleAttachmentRound2CommitPublish = {
  "id": "role-attachment-round2-commit-publish",
  "what": "attachment round 2: commit publishes queued transfer notifications",
  "file": "src/db/database.ts",
  "find": "    for (const notify of committed) notify();\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::committed transfers detach immediately and rolled-back transfers preserve attachments"
  ]
};

export default roleAttachmentRound2CommitPublish;
