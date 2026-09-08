const roleAttachmentRound2TransferReplaced = {
  "id": "role-attachment-round2-transfer-replaced",
  "what": "attachment round 2: replacement transfer invalidates without observation",
  "file": "src/session/binding-registry.ts",
  "find": "      const binding = this.require(roleKey);\n      this.#notifySwitch(binding);\n",
  "replace": "      const binding = this.require(roleKey);\n",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::a committed generation change permanently invalidates the credential"
  ]
};

export default roleAttachmentRound2TransferReplaced;
