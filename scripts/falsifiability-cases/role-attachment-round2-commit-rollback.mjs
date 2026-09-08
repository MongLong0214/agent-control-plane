const roleAttachmentRound2CommitRollback = {
  "id": "role-attachment-round2-commit-rollback",
  "what": "attachment round 2: rollback discards pending transfer notifications",
  "file": "src/db/database.ts",
  "find": "    } catch (err) {\n      this.#afterCommit = [];",
  "replace": "    } catch (err) {",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::committed transfers detach immediately and rolled-back transfers preserve attachments"
  ]
};

export default roleAttachmentRound2CommitRollback;
