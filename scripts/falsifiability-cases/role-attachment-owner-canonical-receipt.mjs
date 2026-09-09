// Consumption keys use serialized receipts; extra fields must not make a spent approval look new.
const roleAttachmentOwnerCanonicalReceipt = {
  "id": "role-attachment-owner-canonical-receipt",
  "what": "attachment authorization: unknown fields cannot change approval consumption identity",
  "file": "src/session/role-attachment-credentials.ts",
  "find": "approval: approvalSchema });",
  "replace": "approval: approvalSchema.passthrough() });",
  "killedBy": [
    "tests/unit/role-attachment-authorization.test.ts::unknown approval fields cannot create a second consumption"
  ]
};

export default roleAttachmentOwnerCanonicalReceipt;
