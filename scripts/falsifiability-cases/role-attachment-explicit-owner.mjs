const roleAttachmentExplicitOwner = {
  "id": "role-attachment-explicit-owner",
  "what": "attachment authorization: omitting an owner decision does not approve",
  "file": "src/daemon/daemon.ts",
  "find": "          const approved = request.params[\"approved\"];\n          if (typeof approved !== \"boolean\") return invalidOperatorParam(\"approved\", approved);\n          const scope =",
  "replace": "          const approved = request.params[\"approved\"] ?? true;\n          if (typeof approved !== \"boolean\") return invalidOperatorParam(\"approved\", approved);\n          const scope =",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::only an explicitly deciding authenticated owner can mint approval"
  ]
};

export default roleAttachmentExplicitOwner;
