const roleAttachmentRound2TransferSurvived = {
  "id": "role-attachment-round2-transfer-survived",
  "what": "attachment round 2: surviving transfer invalidates without observation",
  "file": "src/session/binding-registry.ts",
  "find": "        this.#notifySwitch(binding);\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::an unobserved same-generation round trip permanently revokes an attachment"
  ]
};

export default roleAttachmentRound2TransferSurvived;
